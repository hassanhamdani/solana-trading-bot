import { Connection, PublicKey, VersionedTransactionResponse, TransactionResponse } from '@solana/web3.js';
import { logger } from './helpers';

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

    constructor(connection: Connection, walletAddress: string) {
        this.connection = connection;
        this.walletAddress = walletAddress;
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

        const preTokenBalances = tx.meta.preTokenBalances?.map(this.parseTokenBalances).filter(Boolean) || [];
        const postTokenBalances = tx.meta.postTokenBalances?.map(this.parseTokenBalances).filter(Boolean) || [];
        
        // Get program IDs involved in the transaction
       // const programIds = tx.transaction.message.programIds().map(prog => prog.toString());
        
        // Get relevant logs
        const logs = tx.meta.logMessages || [];
        const relevantLogs = logs.filter(log => 
            log.includes('Instruction:') || 
            log.includes('Program log:') ||
            log.includes('Swap') ||
            log.includes('Transfer')
        );

        logger.info('🔄 Transaction Analysis:');
        logger.info('------------------------');
        logger.info(`Signature: ${tx.transaction.signatures[0]}`);
        logger.info(`Time: ${new Date(tx.blockTime! * 1000).toLocaleString()}`);
        
        // Show token balance changes
        if (preTokenBalances.length > 0 || postTokenBalances.length > 0) {
            logger.info('\n📊 Token Changes:');
            const allMints = new Set([
                ...preTokenBalances.map(b => b!.mint),
                ...postTokenBalances.map(b => b!.mint)
            ]);

            allMints.forEach(mint => {
                const pre = preTokenBalances.find(b => b!.mint === mint)?.uiAmount || 0;
                const post = postTokenBalances.find(b => b!.mint === mint)?.uiAmount || 0;
                const change = post - pre;
                if (change !== 0) {
                    logger.info(`Token: ${mint}`);
                    logger.info(`  ${change > 0 ? '📈 Received' : '📉 Sent'}: ${Math.abs(change)}`);
                }
            });
        }

        // Show programs involved
        logger.info('\n🔧 Programs Involved:');
       // programIds.forEach(prog => logger.info(`  ${prog}`));

        // Show relevant instruction logs
        if (relevantLogs.length > 0) {
            logger.info('\n📝 Key Instructions:');
            relevantLogs.forEach(log => logger.info(`  ${log}`));
        }

        // Show transaction data that might be needed for replication
        logger.info('\n🔑 Trade Data:');
        logger.info(`Recent Blockhash: ${tx.transaction.message.recentBlockhash}`);
        logger.info(`Compute Units: ${tx.meta.computeUnitsConsumed}`);
        
        logger.info('------------------------\n');
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
