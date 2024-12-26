import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionMessage, TransactionInstruction } from '@solana/web3.js';
import {
    Liquidity,
    LiquidityPoolKeys,
    jsonInfo2PoolKeys,
    TOKEN_PROGRAM_ID,
    SPL_ACCOUNT_LAYOUT,
    LiquidityPoolJsonInfo
} from '@raydium-io/raydium-sdk';
import { logger } from './helpers';
import { RaydiumV4Accounts } from './bot';
import { swapConfig } from './src/swapConfig';
import path from 'path';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

export class SwapService {
    private connection: Connection;
    private userWallet: Keypair;
    private poolData: any[] | null = null;

    constructor(connection: Connection, userWallet: Keypair) {
        this.connection = connection;
        this.userWallet = userWallet;
    }

    async executeSwap(
        tokenInMint: string,
        tokenOutMint: string,
        amountIn: number,
        poolAddress: string | undefined,
        raydiumAccounts: RaydiumV4Accounts | undefined
    ): Promise<string | null> {
        try {
            logger.info(`Attempting swap: ${tokenInMint} -> ${tokenOutMint}, amount: ${amountIn}`);
            
            if (!poolAddress) throw new Error('Pool address is required');
            if (!raydiumAccounts) throw new Error('Raydium accounts are required');
            
            const poolKeys = await this.loadPoolKeys(poolAddress);
            if (!poolKeys) throw new Error('Pool keys not found');

            // Check and create token accounts if needed
            const instructions: TransactionInstruction[] = [];
            
            // Get or create token accounts
            const tokenOutATA = await getAssociatedTokenAddress(
                new PublicKey(tokenOutMint),
                this.userWallet.publicKey
            );

            // Check if token account exists
            const tokenAccountInfo = await this.connection.getAccountInfo(tokenOutATA);
            if (!tokenAccountInfo) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        this.userWallet.publicKey, // payer
                        tokenOutATA,               // ATA address
                        this.userWallet.publicKey, // owner
                        new PublicKey(tokenOutMint) // mint
                    )
                );
                logger.info(`Creating token account for ${tokenOutMint}`);
            }

            // Get user's existing token accounts
            const userTokenAccounts = await this.getOwnerTokenAccounts();
            
            // Create Token instances
            const tokenIn = new Token(TOKEN_PROGRAM_ID, new PublicKey(tokenInMint), 9);
            const tokenOut = new Token(TOKEN_PROGRAM_ID, new PublicKey(tokenOutMint), 9);
            const amountInTokenAmount = new TokenAmount(tokenIn, amountIn, false);

            const swapTransaction = await Liquidity.makeSwapInstructionSimple({
                connection: this.connection,
                makeTxVersion: swapConfig.useVersionedTransaction ? 0 : 1,
                poolKeys,
                userKeys: {
                    tokenAccounts: userTokenAccounts,
                    owner: this.userWallet.publicKey,
                },
                amountIn: amountInTokenAmount,
                amountOut: new TokenAmount(tokenOut, 0, false),
                fixedSide: 'in',
                config: {
                    bypassAssociatedCheck: false,
                },
                computeBudgetConfig: {
                    microLamports: swapConfig.maxLamports,
                },
            });

            // Combine ATA creation (if any) with swap instructions
            const allInstructions = [
                ...instructions,
                ...swapTransaction.innerTransactions[0].instructions.filter(Boolean)
            ];

            // Get latest blockhash
            const recentBlockhash = await this.connection.getLatestBlockhash();

            // Create and sign transaction
            let signature: string;
            if (swapConfig.useVersionedTransaction) {
                const versionedTx = new VersionedTransaction(
                    new TransactionMessage({
                        payerKey: this.userWallet.publicKey,
                        recentBlockhash: recentBlockhash.blockhash,
                        instructions: allInstructions,
                    }).compileToV0Message()
                );
                versionedTx.sign([this.userWallet]);
                
                signature = await this.connection.sendTransaction(versionedTx, {
                    skipPreflight: false,
                    maxRetries: swapConfig.maxRetries,
                });
            } else {
                const legacyTx = new Transaction({
                    blockhash: recentBlockhash.blockhash,
                    lastValidBlockHeight: recentBlockhash.lastValidBlockHeight,
                    feePayer: this.userWallet.publicKey,
                }).add(...allInstructions);

                signature = await this.connection.sendTransaction(legacyTx, [this.userWallet], {
                    skipPreflight: false,
                    maxRetries: swapConfig.maxRetries,
                });
            }

            return signature;

        } catch (error: any) {
            logger.error(`Swap execution error: ${error}`);
            if (error.logs) {
                logger.error('Detailed error logs:', error.logs);
            }
            return null;
        }
    }

    private async getOwnerTokenAccounts() {
        const walletTokenAccount = await this.connection.getTokenAccountsByOwner(
            this.userWallet.publicKey,
            { programId: TOKEN_PROGRAM_ID }
        );

        return walletTokenAccount.value.map((i) => ({
            pubkey: i.pubkey,
            programId: i.account.owner,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
        }));
    }

    private async loadPoolKeys(ammId: string): Promise<any> {
        try {
            if (!this.poolData) {
                const mainnetPath = path.join(process.cwd(), 'data', 'mainnet.json');
                const fileStream = createReadStream(mainnetPath, { 
                    encoding: 'utf8',
                    highWaterMark: 1024 * 1024 // 1MB chunks
                });

                let poolData = '';
                for await (const chunk of fileStream) {
                    poolData += chunk;
                }

                this.poolData = JSON.parse(poolData);
            }

            const poolKeys = this.poolData?.find(pool => 
                pool.id.toString() === ammId
            );
            
            if (!poolKeys) {
                throw new Error(`Pool not found for AMM ID: ${ammId}`);
            }
            
            return {
                ...poolKeys,
                lookupTableAccount: null
            };
        } catch (error) {
            logger.error(`Error loading pool keys: ${error}`);
            throw error;
        }
    }
} 