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
        try {
            await fs.writeFile(
                `swap-${signature}.json`,
                JSON.stringify(tx, null, 2)
            );
        } catch (error) {
            logger.error(`Error saving transaction log: ${error}`);
        }

        // Calculate priority fee in SOL
        const priorityFee = tx.meta?.computeUnitsConsumed 
            ? (tx.meta.fee / Math.pow(10, 9)) - ((tx.meta.computeUnitsConsumed * 5000) / Math.pow(10, 9))
            : 0;

        // If you want to get priority fee per compute unit (in SOL):
        const priorityFeePerCU = priorityFee > 0 && tx.meta?.computeUnitsConsumed 
            ? priorityFee / tx.meta.computeUnitsConsumed
            : 0;

        // Parse token balances
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

        if (tokenChanges.length >= 2) {
            const firstSend = tokenChanges[0];
            const firstReceive = tokenChanges[1];

            if (firstSend.change < 0 && firstReceive.change > 0) {
                logger.info('\n🔄 Transaction Details:');
                logger.info('------------------------');
                logger.info(`Signature: ${signature}`);
                logger.info(`Time: ${timestamp}`);
                logger.info(`Priority Fee: ${priorityFee} SOL`);
                
                // Only log the relevant swap
                logger.info('\n📊 Swap Details:');
                logger.info(`📉 Sent: ${Math.abs(firstSend.change)} (${firstSend.mint})`);
                logger.info(`📈 Received: ${firstReceive.change} (${firstReceive.mint})`);

                const raydiumAccounts = this.extractRaydiumV4Accounts(tx);
                
                if (raydiumAccounts) {
                    const tradeDetails: TradeDetails = {
                        tokenIn: {
                            mint: firstSend.mint!,
                            amount: Math.abs(firstSend.change)
                        },
                        tokenOut: {
                            mint: firstReceive.mint!,
                            amount: Math.abs(firstReceive.change)
                        },
                        signature: signature,
                        blockhash: tx.transaction.message.recentBlockhash,
                        computeUnits: tx.meta.computeUnitsConsumed || 0,
                        poolAddress: raydiumAccounts.ammId.toString(),
                        raydiumAccounts
                    };

                    await this.bot.handleTrade(tradeDetails);
                }

                logger.info('------------------------\n');
            }
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

    private isSOLorUSDC(mint: string): boolean {
        const WSOL = 'So11111111111111111111111111111111111111112';
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        return mint === WSOL || mint === USDC;
    }
}
