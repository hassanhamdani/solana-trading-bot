import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, getMint } from '@solana/spl-token';
import { logger } from './helpers';
import { struct, u8, nu64 } from '@solana/buffer-layout';
import { Buffer } from 'buffer';
import { RaydiumV4Accounts } from './bot';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ComputeBudgetProgram } from '@solana/web3.js';

type SwapInstruction = {
    instruction: number;
    amountIn: number;
    minAmountOut: number;
};

export class SwapService {
    private readonly RAYDIUM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    private connection: Connection;
    private userWallet: Keypair;

    constructor(connection: Connection, userWallet: Keypair | string) {
        this.connection = connection;
        
        if (typeof userWallet === 'string') {
            try {
                const privateKeyBytes = bs58.decode(userWallet);
                this.userWallet = Keypair.fromSecretKey(privateKeyBytes);
                logger.info(`Wallet initialized with public key: ${this.userWallet.publicKey.toString()}`);
                logger.info(`Wallet secret key length: ${this.userWallet.secretKey.length}`);
                
                // Verify the wallet has signing capability
                const testData = Buffer.from('test');
                try {
                    const signature = nacl.sign.detached(testData, this.userWallet.secretKey);
                    logger.info('Wallet successfully performed test signature');
                } catch (e) {
                    logger.error('Wallet failed test signature');
                    throw e;
                }
            } catch (error) {
                logger.error(`Failed to create Keypair from private key: ${error}`);
                throw error;
            }
        } else {
            this.userWallet = userWallet;
            logger.info(`Wallet initialized from provided Keypair: ${this.userWallet.publicKey.toString()}`);
        }
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
                
                const createAtaIx = createAssociatedTokenAccountInstruction(
                    this.userWallet.publicKey, // payer
                    associatedTokenAddress, // ata
                    this.userWallet.publicKey, // owner
                    mint // mint
                );

                const transaction = new Transaction();

                // Add priority fee for ATA creation
                // ATA creation typically uses less compute units than swaps
                const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: 25000 // Slightly lower than swap priority fee
                });

                const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
                    units: 25000 // ATA creation usually needs less CU than swaps
                });

                transaction.add(priorityFeeIx);
                transaction.add(computeUnitLimitIx);
                transaction.add(createAtaIx);

                // Get a fresh blockhash
                const latestBlockhash = await this.connection.getLatestBlockhash('finalized');
                transaction.recentBlockhash = latestBlockhash.blockhash;
                transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
                transaction.feePayer = this.userWallet.publicKey;

                // Add retry logic
                let retries = 3;
                while (retries > 0) {
                    try {
                        const signature = await this.connection.sendTransaction(
                            transaction, 
                            [this.userWallet],
                            {
                                skipPreflight: false,
                                preflightCommitment: 'confirmed',
                                maxRetries: 3
                            }
                        );

                        // Wait for confirmation with timeout
                        const confirmation = await Promise.race([
                            this.connection.confirmTransaction({
                                signature,
                                blockhash: latestBlockhash.blockhash,
                                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                            }, 'confirmed'),
                            new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('Confirmation timeout')), 30000)
                            )
                        ]);

                        logger.info(`Created token account: ${associatedTokenAddress.toString()}`);
                        break;
                    } catch (error) {
                        retries--;
                        if (retries === 0) {
                            throw error;
                        }
                        logger.warn(`Retrying token account creation. Attempts remaining: ${retries}`);
                        
                        // Get fresh blockhash for retry
                        const newBlockhash = await this.connection.getLatestBlockhash('finalized');
                        transaction.recentBlockhash = newBlockhash.blockhash;
                    }
                }
            }

            return associatedTokenAddress;
        } catch (error) {
            logger.error(`Error creating token account: ${error}`);
            throw error;
        }
    }

    private async checkTokenAccount(mint: PublicKey): Promise<{ exists: boolean, address: PublicKey }> {
        const address = await getAssociatedTokenAddress(mint, this.userWallet.publicKey);
        const account = await this.connection.getAccountInfo(address);
        return { exists: account !== null, address };
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
            
            // Check if this is a buy or sell
            const isSol = (mint: string) => mint === 'So11111111111111111111111111111111111111112';
            const isSOLorUSDC = (mint: string) => 
                isSol(mint) || 
                mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint

            const isBuy = isSOLorUSDC(tokenInMint);
            logger.info(`Operation type: ${isBuy ? 'BUY' : 'SELL'}`);

            // Check token accounts
            const tokenInCheck = await this.checkTokenAccount(new PublicKey(tokenInMint));
            const tokenOutCheck = await this.checkTokenAccount(new PublicKey(tokenOutMint));
            
            logger.info(`Input token account ${tokenInCheck.exists ? 'exists' : 'needs creation'}`);
            logger.info(`Output token account ${tokenOutCheck.exists ? 'exists' : 'needs creation'}`);

            // Validate account state based on operation type
            if (isBuy) {
                if (!tokenInCheck.exists) {
                    logger.error('Input token account (SOL/USDC) does not exist. Cannot proceed with buy.');
                    return null;
                }
            } else { // Sell
                if (!tokenInCheck.exists) {
                    logger.error('Input token account does not exist. Cannot sell tokens you don\'t have.');
                    return null;
                }
            }

            // Create accounts if needed
            const userTokenAccountIn = tokenInCheck.exists ? 
                tokenInCheck.address : 
                await this.getOrCreateTokenAccount(new PublicKey(tokenInMint));
            
            const userTokenAccountOut = tokenOutCheck.exists ? 
                tokenOutCheck.address : 
                await this.getOrCreateTokenAccount(new PublicKey(tokenOutMint));

            // Verify balance for input token
            const inputBalance = await this.connection.getTokenAccountBalance(userTokenAccountIn);
            logger.info(`Input token balance: ${inputBalance.value.uiAmountString}`);
            
            if (!inputBalance.value.uiAmount || inputBalance.value.uiAmount < amountIn) {
                logger.error(`Insufficient balance. Required: ${amountIn}, Available: ${inputBalance.value.uiAmountString}`);
                return null;
            }

            // Use provided Raydium accounts if available, otherwise try to find them
            if (!raydiumAccounts) {
                logger.error('Raydium V4 accounts not provided');
                //log the raydiumAccounts
                logger.info(`Raydium V4 accounts IN SWAP SERVICE: ${JSON.stringify(raydiumAccounts)}`);
                return null;
            }

            // Here's where we set the user-specific accounts
            let accounts = {
                ...raydiumAccounts,
                userSourceTokenAccount: userTokenAccountIn,      
                userDestTokenAccount: userTokenAccountOut,       
                userAuthority: this.userWallet.publicKey        
            };

            // Validate user-specific accounts
            if (!accounts.userSourceTokenAccount || !accounts.userDestTokenAccount || !accounts.userAuthority) {
                logger.error('Missing user-specific accounts');
                logger.info(`Source Account: ${accounts.userSourceTokenAccount?.toString()}`);
                logger.info(`Destination Account: ${accounts.userDestTokenAccount?.toString()}`);
                logger.info(`User Authority: ${accounts.userAuthority?.toString()}`);
                return null;
            }

            // Verify ownership of token accounts
            try {
                const sourceInfo = await this.connection.getAccountInfo(accounts.userSourceTokenAccount);
                const destInfo = await this.connection.getAccountInfo(accounts.userDestTokenAccount);
                
                if (!sourceInfo || !destInfo) {
                    logger.error('Token accounts not found');
                    return null;
                }

                logger.info('✅ User accounts validated successfully');
            } catch (error) {
                logger.error(`Error validating token accounts: ${error}`);
                return null;
            }

            logger.info(`User Authority (Wallet Public Key): ${this.userWallet.publicKey.toString()}`);
            
            logger.info('Static Accounts Array:');
            const accountsArray = [
                { name: 'ammId', pubkey: accounts.ammId },
                { name: 'ammAuthority', pubkey: accounts.ammAuthority },
                { name: 'ammOpenOrders', pubkey: accounts.ammOpenOrders },
                { name: 'ammTargetOrders', pubkey: accounts.ammTargetOrders },
                { name: 'poolCoinTokenAccount', pubkey: accounts.poolCoinTokenAccount },
                { name: 'poolPcTokenAccount', pubkey: accounts.poolPcTokenAccount },
                { name: 'serumProgramId', pubkey: accounts.serumProgramId },
                { name: 'serumMarket', pubkey: accounts.serumMarket },
                { name: 'serumBids', pubkey: accounts.serumBids },
                { name: 'serumAsks', pubkey: accounts.serumAsks },
                { name: 'serumEventQueue', pubkey: accounts.serumEventQueue },
                { name: 'serumCoinVaultAccount', pubkey: accounts.serumCoinVaultAccount },
                { name: 'serumPcVaultAccount', pubkey: accounts.serumPcVaultAccount },
                { name: 'serumVaultSigner', pubkey: accounts.serumVaultSigner },
                { name: 'userSourceTokenAccount', pubkey: accounts.userSourceTokenAccount },
                { name: 'userDestTokenAccount', pubkey: accounts.userDestTokenAccount },
                { name: 'userAuthority', pubkey: accounts.userAuthority },
                { name: 'tokenProgramId', pubkey: TOKEN_PROGRAM_ID }
            ];

            accountsArray.forEach((account, index) => {
                logger.info(`${index}: ${account.name} = ${account.pubkey.toString()}`);
            });

            // Create Raydium V4 swap instruction
            const swapIx = new TransactionInstruction({
                programId: this.RAYDIUM_V4_PROGRAM_ID,
                keys: [
                    // AMM Accounts
                    { pubkey: accounts.ammId, isSigner: false, isWritable: true },
                    { pubkey: accounts.ammAuthority, isSigner: false, isWritable: false },
                    { pubkey: accounts.ammOpenOrders, isSigner: false, isWritable: true },
                    { pubkey: accounts.ammTargetOrders, isSigner: false, isWritable: true },
                    { pubkey: accounts.poolCoinTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.poolPcTokenAccount, isSigner: false, isWritable: true },
                    
                    // Serum Accounts
                    { pubkey: accounts.serumMarket, isSigner: false, isWritable: true },
                    { pubkey: new PublicKey('9xQeWvG816bUx9CEPZ6tWx3i1G7NbELTAgf8rLj4tBe'), isSigner: false, isWritable: false },
                    { pubkey: accounts.serumBids, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumAsks, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumEventQueue, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumCoinVaultAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumPcVaultAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.serumVaultSigner, isSigner: false, isWritable: false },
                    
                    // User Accounts
                    { pubkey: accounts.userSourceTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.userDestTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: accounts.userAuthority, isSigner: true, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                data: await this.encodeRaydiumV4SwapData(amountIn, new PublicKey(tokenInMint))
            });

            const transaction = new Transaction();
            
            // Add priority fee instruction
            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 30000 // Adjust this value to increase/decrease priority
            });
            
            // Add compute unit limit instruction (optional but recommended)
            const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
                units: 100000 // Adjust based on your transaction needs
            });

            transaction.add(priorityFeeIx);
            transaction.add(computeUnitLimitIx);
            transaction.add(swapIx);

            const latestBlockhash = await this.connection.getLatestBlockhash('finalized');
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
            transaction.feePayer = this.userWallet.publicKey;

            transaction.sign(this.userWallet);

            const signature = await this.connection.sendTransaction(
                transaction,
                [this.userWallet],
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3
                }
            );
            
            // Wait for confirmation with more detailed options
            const confirmation = await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                logger.error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
                return null;
            }

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