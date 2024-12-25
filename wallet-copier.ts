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

interface RaydiumV4Accounts {
    ammId: PublicKey;
    ammAuthority: PublicKey;
    ammOpenOrders: PublicKey;
    ammTargetOrders: PublicKey;
    poolCoinTokenAccount: PublicKey;
    poolPcTokenAccount: PublicKey;
    serumProgramId: PublicKey;
    serumMarket: PublicKey;
    serumBids: PublicKey;
    serumAsks: PublicKey;
    serumEventQueue: PublicKey;
    serumCoinVaultAccount: PublicKey;
    serumPcVaultAccount: PublicKey;
    serumVaultSigner: PublicKey;
    userSourceTokenAccount: PublicKey | undefined;
    userDestTokenAccount: PublicKey | undefined;
    userAuthority: PublicKey | undefined;
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

    private extractRaydiumV4Accounts(tx: TransactionResponse | VersionedTransactionResponse): RaydiumV4Accounts | null {
        try {
            const raydiumV4ProgramId = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
            
            // Safely access message and instructions
            const message = tx.transaction?.message;
            if (!message || !message.compiledInstructions) {
                logger.error('Transaction message or compiled instructions not found');
                return null;
            }


            const staticAccounts = message.staticAccountKeys;

            // Safely create PublicKeys with validation
            const createSafePublicKey = (account: any, label: string): PublicKey | null => {
                try {
                    if (!account) {
                        logger.error(`Missing account for ${label}`);
                        return null;
                    }
                    return new PublicKey(account.toString());
                } catch (error) {
                    logger.error(`Error creating PublicKey for ${label}: ${error}`);
                    return null;
                }
            };

            const ammId = createSafePublicKey(staticAccounts[1], 'ammId');
            const ammAuthority = createSafePublicKey(staticAccounts[3], 'ammAuthority');
            const ammOpenOrders = createSafePublicKey(staticAccounts[2], 'ammOpenOrders');
            const ammTargetOrders = createSafePublicKey(staticAccounts[4], 'ammTargetOrders');
            const poolCoinTokenAccount = createSafePublicKey(staticAccounts[5], 'poolCoinTokenAccount');
            const poolPcTokenAccount = createSafePublicKey(staticAccounts[6], 'poolPcTokenAccount');
            const serumProgramId = createSafePublicKey(staticAccounts[8], 'serumProgramId');
            const serumMarket = createSafePublicKey(staticAccounts[7], 'serumMarket');
            const serumBids = createSafePublicKey(staticAccounts[9], 'serumBids');
            const serumAsks = createSafePublicKey(staticAccounts[10], 'serumAsks');
            const serumEventQueue = createSafePublicKey(staticAccounts[11], 'serumEventQueue');
            const serumCoinVaultAccount = createSafePublicKey(staticAccounts[12], 'serumCoinVaultAccount');
            const serumPcVaultAccount = createSafePublicKey(staticAccounts[13], 'serumPcVaultAccount');
            const serumVaultSigner = createSafePublicKey(staticAccounts[14], 'serumVaultSigner');

            // Verify all required accounts are present
            if (!ammId || !ammAuthority || !ammOpenOrders || !ammTargetOrders || 
                !poolCoinTokenAccount || !poolPcTokenAccount || !serumProgramId || 
                !serumMarket || !serumBids || !serumAsks || !serumEventQueue || 
                !serumCoinVaultAccount || !serumPcVaultAccount || !serumVaultSigner) {
                logger.error('One or more required accounts are missing');
                return null;
            }

            return {
                ammId,
                ammAuthority,
                ammOpenOrders,
                ammTargetOrders,
                poolCoinTokenAccount,
                poolPcTokenAccount,
                serumProgramId,
                serumMarket,
                serumBids,
                serumAsks,
                serumEventQueue,
                serumCoinVaultAccount,
                serumPcVaultAccount,
                serumVaultSigner,
                userSourceTokenAccount: undefined,
                userDestTokenAccount: undefined,
                userAuthority: undefined,
            };

        } catch (error) {
            logger.error(`Error extracting Raydium V4 accounts: ${error}`);
            if (error instanceof Error) {
                logger.error(`Stack trace: ${error.stack}`);
            }
            return null;
        }
    }

    private async analyzeTransaction(tx: TransactionResponse | VersionedTransactionResponse) {
        if (!tx.meta) return;

        const signature = tx.transaction.signatures[0];
        const timestamp = tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Unknown';

        // Create log object
        const logData = {
            signature,
            timestamp,
            allLogs: tx.meta.logMessages,
            preTokenBalances: tx.meta.preTokenBalances,
            postTokenBalances: tx.meta.postTokenBalances,
            rawTransaction: tx
        };

        // Save complete log to file
        const logFileName = `swap-${signature}.json`;
        await fs.writeFile(logFileName, JSON.stringify(logData, null, 2));

        // Continue with existing trade processing logic
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
                const raydiumAccounts = this.extractRaydiumV4Accounts(tx);
                
                if (raydiumAccounts) {
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
                        poolAddress: raydiumAccounts.ammId.toString(),
                        raydiumAccounts  // Add the full accounts structure
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
