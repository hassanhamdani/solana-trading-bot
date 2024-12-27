import { Connection, PublicKey, VersionedTransactionResponse, TransactionResponse } from '@solana/web3.js';
import { logger } from './helpers';
import { CopyTradingBot, TradeDetails } from './bot';
import { promises as fs } from 'fs';

interface TokenBalance {
    mint: string;
    amount: string;
    decimals: number;
    uiAmount: number;
}

export class SwapTracker {
    private connection: Connection;
    private walletAddress: string;
    private isTracking: boolean = false;
    private lastProcessedTime: number = 0;
    private readonly RATE_LIMIT_DELAY = 500;
    private bot: CopyTradingBot;

    constructor(connection: Connection, walletAddress: string, bot: CopyTradingBot) {
        this.connection = connection;
        this.walletAddress = walletAddress;
        this.bot = bot;
    }

    private parseTokenBalances(balance: any): TokenBalance | null {
        if (!balance?.mint || !balance?.uiTokenAmount) return null;
        return {
            mint: balance.mint,
            amount: balance.uiTokenAmount.amount,
            decimals: balance.uiTokenAmount.decimals,
            uiAmount: parseFloat(balance.uiTokenAmount.uiAmountString || '0')
        };
    }

    private async analyzeTransaction(tx: TransactionResponse | VersionedTransactionResponse) {
        if (!tx.meta) return;

        const signature = tx.transaction.signatures[0];
        const timestamp = tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Unknown';

        // Parse token balances with owner information
        const preTokenBalances = tx.meta.preTokenBalances?.map(balance => ({
            ...this.parseTokenBalances(balance),
            owner: balance.owner
        })).filter(Boolean) || [];
        
        const postTokenBalances = tx.meta.postTokenBalances?.map(balance => ({
            ...this.parseTokenBalances(balance),
            owner: balance.owner
        })).filter(Boolean) || [];

        // Get the wallet's token changes
        const walletChanges = postTokenBalances
            .filter(post => post.owner === this.walletAddress)
            .map(post => {
                const pre = preTokenBalances.find(p => p.mint === post.mint && p.owner === this.walletAddress);
                return {
                    mint: post.mint,
                    change: (post.uiAmount || 0) - (pre?.uiAmount || 0)
                };
            })
            .filter(change => Math.abs(change.change) > 0.000001);

        // Find the actual swap by looking for positive change (token received)
        const tokenReceived = walletChanges.find(change => change.change > 0);
        const tokenSent = walletChanges.find(change => change.change < 0);

        if (tokenReceived && tokenSent) {
            logger.info('\n🔄 Transaction Details:');
            logger.info('------------------------');
            logger.info(`Signature: ${signature}`);
            logger.info(`Time: ${timestamp}`);
            
            logger.info('\n📊 Swap Details:');
            logger.info(`📉 Sent: ${Math.abs(tokenSent.change)} (${tokenSent.mint})`);
            logger.info(`📈 Received: ${tokenReceived.change} (${tokenReceived.mint})`);

            const tradeDetails: TradeDetails = {
                tokenIn: {
                    mint: tokenSent.mint!,
                    amount: Math.abs(tokenSent.change)
                },
                tokenOut: {
                    mint: tokenReceived.mint!,
                    amount: tokenReceived.change
                },
                signature: signature,
                blockhash: tx.transaction.message.recentBlockhash,
                computeUnits: tx.meta.computeUnitsConsumed || 0,
                poolAddress: '',
            };

            await this.bot.handleTrade(tradeDetails);
            logger.info('------------------------\n');
        }
    }

    async trackSwaps() {
        this.isTracking = true;
        logger.info(`🎯 Starting to track wallet: ${this.walletAddress}`);
        let lastHeartbeat = Date.now();
        const HEARTBEAT_INTERVAL = 30000; // 30 seconds

        try {
            const subscriptionId = this.connection.onLogs(
                new PublicKey(this.walletAddress),
                async (logs) => {
                    const currentTime = Date.now();
                    if (currentTime - this.lastProcessedTime < this.RATE_LIMIT_DELAY) {
                        return;
                    }
                    this.lastProcessedTime = currentTime;

                    if (!logs.err) {
                        try {
                            const tx = await this.connection.getTransaction(logs.signature, {
                                maxSupportedTransactionVersion: 0,
                            });

                            if (tx && tx.meta && !tx.meta.err) {
                                await this.analyzeTransaction(tx);
                            }
                        } catch (error) {
                            logger.error(`Error fetching transaction details: ${error}`);
                        }
                    }
                },
                'confirmed'
            );

            logger.info('✅ Wallet tracking started successfully');

            while (this.isTracking) {
                const currentTime = Date.now();
                if (currentTime - lastHeartbeat >= HEARTBEAT_INTERVAL) {
                    logger.info('💗 Wallet tracker heartbeat - Still monitoring transactions');
                    lastHeartbeat = currentTime;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            this.connection.removeOnLogsListener(subscriptionId);
        } catch (error) {
            logger.error(`Error in trackSwaps: ${error}`);
            this.isTracking = false;
        }
    }

    stop() {
        this.isTracking = false;
        logger.info('🛑 Stopping wallet tracking...');
    }

    private isSOLorUSDC(mint: string): boolean {
        const WSOL = 'So11111111111111111111111111111111111111112';
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        return mint === WSOL || mint === USDC;
    }
}
