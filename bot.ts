import { Connection, PublicKey, Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';
import { logger } from './helpers';
import { SwapTracker } from './wallet-copier';
import fetch from 'cross-fetch';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import { SwapService } from './swap-service';


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
    poolAddress?: string;
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
    private swapService: SwapService;

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
        this.swapService = new SwapService(connection, this.userWallet);
        
        // Bind the trade handler to this instance
        this.handleTrade = this.handleTrade.bind(this);
    }

    private async executeSwap(tokenIn: string, tokenOut: string, amount: number, poolAddress?: string): Promise<string | null> {
        return await this.swapService.executeSwap(tokenIn, tokenOut, amount, poolAddress);
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
                tx.tokenIn.amount,
                tx.poolAddress
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
