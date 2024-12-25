import { Connection, PublicKey, VersionedTransactionResponse, TransactionResponse } from '@solana/web3.js';
import { logger } from './helpers';
import { CopyTradingBot, TradeDetails } from './bot';

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

        // Extract key transaction details
        const signature = tx.transaction.signatures[0];
        const timestamp = tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Unknown';
        
        // Get token balance changes
        const preTokenBalances = tx.meta.preTokenBalances?.map(this.parseTokenBalances).filter(Boolean) || [];
        const postTokenBalances = tx.meta.postTokenBalances?.map(this.parseTokenBalances).filter(Boolean) || [];
        
        // Calculate token changes
        const tokenChanges = postTokenBalances.map(post => {
            const pre = preTokenBalances.find(p => p?.mint === post?.mint);
            return {
                mint: post?.mint,
                change: (post?.uiAmount || 0) - (pre?.uiAmount || 0)
            };
        }).filter(change => change.change !== 0);

        // Only log if there are token changes
        if (tokenChanges.length > 0) {
            logger.info('\n🔄 Transaction Details:');
            logger.info('------------------------');
            logger.info(`Signature: ${signature}`);
            logger.info(`Time: ${timestamp}`);
            
            logger.info('\n📊 Token Changes:');
            tokenChanges.forEach(change => {
                const direction = change.change > 0 ? '📈 Received' : '📉 Sent';
                logger.info(`${direction}: ${Math.abs(change.change)} (Mint: ${change.mint})`);
            });

            // Get relevant program logs (only swap-related)
            const relevantLogs = tx.meta.logMessages?.filter(log => 
                log.includes('Instruction: Swap') ||
                log.includes('Program log: Swap') ||
                log.includes('Program log: ray_log')
            ) || [];

            if (relevantLogs.length > 0) {
                logger.info('\n📝 Swap Details:');
                relevantLogs.forEach(log => {
                    if (log.includes('ray_log')) {
                        logger.info('  Raydium Swap Executed');
                    } else {
                        logger.info(`  ${log}`);
                    }
                });
            }

            // Prepare trade details and call the bot
            const tokenIn = tokenChanges.find(t => t.change < 0);
            const tokenOut = tokenChanges.find(t => t.change > 0);

            if (tokenIn && tokenOut) {
                const raydiumV4ProgramId = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
                
                // Find Raydium instruction (index 2 in this case based on the log)
                const raydiumInstruction = tx.transaction.message.compiledInstructions.find(
                    ix => tx.transaction.message.staticAccountKeys[ix.programIdIndex].toString() === raydiumV4ProgramId
                );

                if (raydiumInstruction) {
                    // The pool address is the second account in the instruction (index 1)
                    const poolAddress = tx.transaction.message.staticAccountKeys[raydiumInstruction.accountKeyIndexes[1]];
                    logger.info(`Found Raydium pool address: ${poolAddress.toString()}`);

                    const tradeDetails: TradeDetails = {
                        tokenIn: {
                            mint: tokenIn.mint!,
                            amount: Math.abs(tokenIn.change)
                        },
                        tokenOut: {
                            mint: tokenOut.mint!,
                            amount: tokenOut.change
                        },
                        signature: signature,
                        blockhash: tx.transaction.message.recentBlockhash,
                        computeUnits: tx.meta.computeUnitsConsumed || 0,
                        poolAddress: poolAddress.toString()  // Add the pool address
                    };

                    await this.bot.handleTrade(tradeDetails);
                }
            }

            logger.info('------------------------\n');
        }
    }

    async trackSwaps() {
        this.isTracking = true;
        logger.info(`🎯 Starting to track wallet: ${this.walletAddress}`);

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
                await new Promise(resolve => setTimeout(resolve, 1000));
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
}
