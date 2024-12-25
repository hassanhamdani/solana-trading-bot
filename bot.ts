import { Connection, PublicKey, Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';
import { logger } from './helpers';
import { SwapTracker } from './wallet-copier';
import fetch from 'cross-fetch';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';


export interface TradeDetails {
    tokenIn: {
        mint: string;
        amount: number;
    };
    tokenOut: {
        mint: string;
        amount: number;
    };
    signature: string;
    blockhash: string;
    computeUnits: number;
}

export class CopyTradingBot {
    private connection: Connection;
    private targetWallet: string;
    private userWallet: Keypair;
    private swapTracker: SwapTracker;
    private isRunning: boolean = false;
    private readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';
    private readonly SOLANA_TRACKER_API = 'https://swap-v2.solanatracker.io/swap';
    private readonly slippagePercentage = Number(process.env.BUY_SLIPPAGE) || 20;
    private readonly computeUnitPrice = Number(process.env.COMPUTE_UNIT_PRICE) || 421197;

    constructor(
        connection: Connection,
        targetWallet: string,
        privateKey: string
    ) {
        this.connection = connection;
        this.targetWallet = targetWallet;
        // Convert base58 private key to Uint8Array
        const bs58 = require('bs58');
        const decodedKey = bs58.decode(privateKey);
        this.userWallet = Keypair.fromSecretKey(decodedKey);
        this.swapTracker = new SwapTracker(connection, targetWallet, this);
        
        // Bind the trade handler to this instance
        this.handleTrade = this.handleTrade.bind(this);
    }

    private async executeSwap(tokenIn: string, tokenOut: string, amount: number): Promise<string | null> {
        try {
            // Prepare the swap request
            const swapRequest = {
                from: tokenIn,
                to: tokenOut,
                amount: amount,
                slippage: this.slippagePercentage,
                payer: this.userWallet.publicKey.toString(),
                priorityFee: this.computeUnitPrice / 1_000_000, // Convert to SOL
                feeType: "add"
            };

            logger.info('Swap request:', swapRequest);

            // Get the swap transaction
            const response = await fetch(this.SOLANA_TRACKER_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(swapRequest)
            });

            // Add detailed error logging for non-200 responses
            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`API Error (${response.status}): ${errorText}`);
                return null;
            }

            const data = await response.json();
            
            if (!data || !data.txn) {
                logger.error('Invalid swap response:', data);
                return null;
            }

            // Deserialize and sign transaction
            const serializedTxBuffer = Buffer.from(data.txn, 'base64');
            let transaction;

            if (data.type === 'v0') {
                transaction = VersionedTransaction.deserialize(serializedTxBuffer);
                transaction.sign([this.userWallet]);
            } else {
                transaction = Transaction.from(serializedTxBuffer);
                transaction.sign(this.userWallet);
            }

            // Send transaction
            const signature = await this.connection.sendRawTransaction(
                data.type === 'v0' ? transaction.serialize() : transaction.serialize(),
                {
                    skipPreflight: true,
                    maxRetries: 4
                }
            );

            // Wait for confirmation
            const latestBlockHash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                blockhash: latestBlockHash.blockhash,
                lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                signature
            });

            return signature;

        } catch (error) {
            // Improve error logging with more details
            if (error instanceof Error) {
                logger.error(`Error executing swap: ${error.message}`);
                logger.error(`Stack trace: ${error.stack}`);
            } else {
                logger.error(`Error executing swap:`, error);
            }
            return null;
        }
    }

    public async handleTrade(tx: TradeDetails) {
        try {
            logger.info(`🔄 Copying trade from transaction: ${tx.signature}`);
            logger.info('Trade details:', tx);
            
            if (!tx.tokenIn.mint || !tx.tokenOut.mint || !tx.tokenIn.amount) {
                logger.error('Invalid trade details:', tx);
                return;
            }

            const signature = await this.executeSwap(
                tx.tokenIn.mint,
                tx.tokenOut.mint,
                tx.tokenIn.amount
            );
            
            if (signature) {
                logger.info(`✅ Successfully copied trade!`);
                logger.info(`Transaction signature: ${signature}`);
                logger.info(`Solscan: https://solscan.io/tx/${signature}`);
            } else {
                logger.error('Failed to execute swap');
            }

        } catch (error) {
            logger.error(`❌ Error copying trade:`, error);
        }
    }

    private parseTrade(txData: any): TradeDetails | null {
        try {
            // Extract token changes
            const tokenChanges = txData.meta.postTokenBalances.map((post: any) => {
                const pre = txData.meta.preTokenBalances.find(
                    (pre: any) => pre.mint === post.mint
                );
                return {
                    mint: post.mint,
                    change: (post.uiTokenAmount.uiAmount || 0) - (pre?.uiTokenAmount.uiAmount || 0)
                };
            });

            // Find the tokens involved in the swap
            const tokenIn = tokenChanges.find((t: any) => t.change < 0);
            const tokenOut = tokenChanges.find((t: any) => t.change > 0);

            if (!tokenIn || !tokenOut) return null;

            return {
                tokenIn: {
                    mint: tokenIn.mint,
                    amount: Math.abs(tokenIn.change)
                },
                tokenOut: {
                    mint: tokenOut.mint,
                    amount: tokenOut.change
                },
                signature: txData.transaction.signatures[0],
                blockhash: txData.transaction.message.recentBlockhash,
                computeUnits: txData.meta.computeUnitsConsumed
            };
        } catch (error) {
            logger.error(`Error parsing trade: ${error}`);
            return null;
        }
    }

    async start() {
        this.isRunning = true;
        logger.info(`🤖 Starting copy trading bot...`);
        logger.info(`Target wallet: ${this.targetWallet}`);
        logger.info(`Your wallet: ${this.userWallet.publicKey.toString()}`);


        // Start tracking swaps
        await this.swapTracker.trackSwaps();
    }

    stop() {
        this.isRunning = false;
        // Remove event listener
        this.swapTracker.stop();
        logger.info(`🛑 Stopping copy trading bot...`);
    }
}
