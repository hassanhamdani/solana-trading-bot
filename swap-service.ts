import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, getMint } from '@solana/spl-token';
import { logger } from './helpers';
import { struct, u8, nu64 } from '@solana/buffer-layout';
import { Buffer } from 'buffer';
import { RaydiumV4Accounts } from './bot';

type SwapInstruction = {
    instruction: number;
    amountIn: number;
    minAmountOut: number;
};

export class SwapService {
    private readonly RAYDIUM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    private connection: Connection;
    private userWallet: Keypair;

    constructor(connection: Connection, userWallet: Keypair) {
        this.connection = connection;
        this.userWallet = userWallet;
    }

    async findPoolAccounts(tokenInMint: PublicKey, tokenOutMint: PublicKey, poolAddress?: string) {
        try {
            // Log the tokens we're looking for
            logger.info(`Searching for pool with tokens:`);
            logger.info(`Token In: ${tokenInMint.toString()}`);
            logger.info(`Token Out: ${tokenOutMint.toString()}`);

            if (poolAddress) {
                const poolPubkey = new PublicKey(poolAddress);
                const poolData = await this.connection.getAccountInfo(poolPubkey);
                
                if (!poolData) {
                    logger.error(`Pool not found for address: ${poolAddress}`);
                    return null;
                }

                return {
                    poolId: poolPubkey,
                    tokenAAccount: new PublicKey(poolData.data.slice(72, 104)),
                    tokenBAccount: new PublicKey(poolData.data.slice(104, 136)),
                    configAccount: new PublicKey(poolData.data.slice(40, 72))
                };
            }

            // Try finding pools with tokenIn as either token
            const pools = await Promise.all([
                // Search with tokenIn as token A
                this.connection.getProgramAccounts(this.RAYDIUM_V4_PROGRAM_ID, {
                    filters: [
                        { dataSize: 392 },
                        {
                            memcmp: {
                                offset: 8,
                                bytes: tokenInMint.toBase58()
                            }
                        }
                    ]
                }),
                // Search with tokenIn as token B
                this.connection.getProgramAccounts(this.RAYDIUM_V4_PROGRAM_ID, {
                    filters: [
                        { dataSize: 392 },
                        {
                            memcmp: {
                                offset: 40,
                                bytes: tokenInMint.toBase58()
                            }
                        }
                    ]
                })
            ]);

            const allPools = [...pools[0], ...pools[1]];
            
            logger.info(`Found ${allPools.length} potential pools for token ${tokenInMint.toString()}`);

            // Try to find a pool with the matching pair
            for (const pool of allPools) {
                try {
                    const poolData = await this.connection.getAccountInfo(pool.pubkey);
                    if (!poolData) continue;

                    const tokenAMint = new PublicKey(poolData.data.slice(8, 40));
                    const tokenBMint = new PublicKey(poolData.data.slice(40, 72));
                    const tokenAAccount = new PublicKey(poolData.data.slice(72, 104));
                    const tokenBAccount = new PublicKey(poolData.data.slice(104, 136));

                    logger.info(`\nChecking pool ${pool.pubkey.toString()}:`);
                    logger.info(`Token A Mint: ${tokenAMint.toString()}`);
                    logger.info(`Token B Mint: ${tokenBMint.toString()}`);
                    logger.info(`Token A Account: ${tokenAAccount.toString()}`);
                    logger.info(`Token B Account: ${tokenBAccount.toString()}`);

                    if ((tokenAMint.equals(tokenInMint) && tokenBMint.equals(tokenOutMint)) ||
                        (tokenBMint.equals(tokenInMint) && tokenAMint.equals(tokenOutMint))) {
                        
                        logger.info(`✅ Found matching pool: ${pool.pubkey.toString()}`);
                        
                        return {
                            poolId: pool.pubkey,
                            tokenAAccount,
                            tokenBAccount,
                            configAccount: new PublicKey(poolData.data.slice(40, 72))
                        };
                    }
                } catch (error) {
                    logger.error(`Error checking pool ${pool.pubkey.toString()}: ${error}`);
                    continue;
                }
            }

            // If no direct pool is found, try to find a route through USDC
            const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            if (!tokenInMint.equals(new PublicKey(USDC_MINT)) && !tokenOutMint.equals(new PublicKey(USDC_MINT))) {
                logger.info('Attempting to find route through USDC...');
                const usdcMint = new PublicKey(USDC_MINT);
                
                // Try to find a pool for tokenIn -> USDC
                const poolWithUsdc = await this.findPoolAccounts(tokenInMint, usdcMint);
                if (poolWithUsdc) {
                    logger.info('Found intermediate USDC pool. You may need to execute this as two separate swaps.');
                }
            }

            logger.error(`No pool found for pair ${tokenInMint.toString()} -> ${tokenOutMint.toString()}`);
            return null;
        } catch (error) {
            logger.error(`Error in findPoolAccounts: ${error}`);
            return null;
        }
    }

    private async encodeRaydiumV4SwapData(amountIn: number, tokenInMint: PublicKey): Promise<Buffer> {
        try {
            // Get mint info to determine decimals
            const mintInfo = await getMint(this.connection, tokenInMint);
            
            // Convert amount to smallest unit based on decimals
            const multiplier = Math.pow(10, mintInfo.decimals);
            const rawAmount = Math.floor(amountIn * multiplier);
            
            // Calculate minimum amount out based on slippage (e.g., 1% slippage)
            const slippage = 0.01; // 1%
            const minAmountOut = Math.floor(rawAmount * (1 - slippage));

            // Define the instruction layout
            const dataLayout = struct<SwapInstruction>([
                u8('instruction'),
                nu64('amountIn'),
                nu64('minAmountOut')
            ]);

            // Allocate buffer for the instruction data
            const data = Buffer.alloc(dataLayout.span);

            // Encode the instruction data - remove BigInt conversion
            dataLayout.encode(
                {
                    instruction: 9,
                    amountIn: rawAmount,
                    minAmountOut: minAmountOut
                },
                data
            );

            return data;
        } catch (error) {
            logger.error(`Error encoding swap data: ${error}`);
            throw error;
        }
    }

    private async getOrCreateTokenAccount(mint: PublicKey): Promise<PublicKey> {
        try {
            // Get the associated token address
            const associatedTokenAddress = await getAssociatedTokenAddress(
                mint,
                this.userWallet.publicKey
            );

            // Check if the account exists
            const account = await this.connection.getAccountInfo(associatedTokenAddress);

            if (!account) {
                logger.info(`Creating token account for mint: ${mint.toString()}`);
                
                // Create the account if it doesn't exist
                const createAtaIx = createAssociatedTokenAccountInstruction(
                    this.userWallet.publicKey, // payer
                    associatedTokenAddress, // ata
                    this.userWallet.publicKey, // owner
                    mint // mint
                );

                const transaction = new Transaction().add(createAtaIx);
                const latestBlockhash = await this.connection.getLatestBlockhash();
                transaction.recentBlockhash = latestBlockhash.blockhash;
                transaction.feePayer = this.userWallet.publicKey;

                const signature = await this.connection.sendTransaction(transaction, [this.userWallet]);
                await this.connection.confirmTransaction({
                    signature,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                });

                logger.info(`Created token account: ${associatedTokenAddress.toString()}`);
            }

            return associatedTokenAddress;
        } catch (error) {
            logger.error(`Error creating token account: ${error}`);
            throw error;
        }
    }

    async executeSwap(
        tokenInMint: string, 
        tokenOutMint: string, 
        amountIn: number,
        poolAddress?: string,
        raydiumAccounts?: RaydiumV4Accounts
    ): Promise<string | null> {
        try {
            logger.info(`Attempting swap: ${tokenInMint} -> ${tokenOutMint}, amount: ${amountIn}`);
            
            const tokenInPubkey = new PublicKey(tokenInMint);
            const tokenOutPubkey = new PublicKey(tokenOutMint);

            // Get or create token accounts
            const userTokenAccountIn = await this.getOrCreateTokenAccount(tokenInPubkey);
            const userTokenAccountOut = await this.getOrCreateTokenAccount(tokenOutPubkey);

            // Use provided Raydium accounts if available, otherwise try to find them
            if (!raydiumAccounts) {
                logger.error('Raydium V4 accounts not provided');
                return null;
            }

            // Here's where we set the user-specific accounts
            let accounts = {
                ...raydiumAccounts,
                userSourceTokenAccount: userTokenAccountIn,      // Token account for input token
                userDestTokenAccount: userTokenAccountOut,       // Token account for output token
                userAuthority: this.userWallet.publicKey        // Your wallet's public key
            };

            // Create Raydium V4 swap instruction
            const swapIx = new TransactionInstruction({
                programId: this.RAYDIUM_V4_PROGRAM_ID,
                keys: [
                    { pubkey: accounts.ammId, isSigner: false, isWritable: true },
                    { pubkey: accounts.ammAuthority, isSigner: false, isWritable: false },
                    { pubkey: accounts.ammOpenOrders, isSigner: false, isWritable: true },
                    { pubkey: accounts.ammTargetOrders, isSigner: false, isWritable: true },
                    { pubkey: accounts.poolCoinTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.poolPcTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumProgramId, isSigner: false, isWritable: false },
                    { pubkey: accounts.serumMarket, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumBids, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumAsks, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumEventQueue, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumCoinVaultAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumPcVaultAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumVaultSigner, isSigner: false, isWritable: false },
                    { pubkey: accounts.userSourceTokenAccount, isSigner: false, isWritable: true },  // Index 14
                    { pubkey: accounts.userDestTokenAccount, isSigner: false, isWritable: true },    // Index 15
                    { pubkey: accounts.userAuthority, isSigner: true, isWritable: false },          // Index 16
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                data: await this.encodeRaydiumV4SwapData(amountIn, tokenInPubkey)
            });

            const transaction = new Transaction().add(swapIx);
            const latestBlockhash = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.feePayer = this.userWallet.publicKey;

            const signature = await this.connection.sendTransaction(transaction, [this.userWallet]);
            
            await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            });

            return signature;

        } catch (error) {
            logger.error(`Swap execution error: ${error}`);
            if (error instanceof Error) {
                logger.error(`Error stack: ${error.stack}`);
            }
            return null;
        }
    }

    async getPoolAddress(tokenAMint: string, tokenBMint: string): Promise<string | null> {
        try {
            const tokenAPubkey = new PublicKey(tokenAMint);
            const tokenBPubkey = new PublicKey(tokenBMint);
            
            const poolAccounts = await this.findPoolAccounts(tokenAPubkey, tokenBPubkey);
            if (poolAccounts) {
                return poolAccounts.poolId.toString();
            }
            return null;
        } catch (error) {
            logger.error(`Error getting pool address: ${error}`);
            return null;
        }
    }
} 