import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { Bot } from './bot';
import { logger } from './helpers';

export class WalletCopier {
    private lastRequestTime = 0;
    private readonly MIN_REQUEST_INTERVAL = 2000; // Increased to 2 seconds
    private isConnected = false;
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;

    constructor(
        private readonly connection: Connection,
        private readonly bot: Bot,
        private readonly targetWallet: string
    ) {}

    async trackTrades() {
        await this.startTracking();
        
        // Add heartbeat to check connection
        setInterval(() => this.checkConnection(), 30000); // Check every 30 seconds
    }

    private async startTracking() {
        const pubKey = new PublicKey(this.targetWallet);
        
        try {
            await this.connection.getSlot();
            
            // Subscribe to token account changes
            this.connection.onProgramAccountChange(
                new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
                async (accountInfo) => {
                    this.isConnected = true;
                    this.reconnectAttempts = 0;

                    // Rate limiting
                    const now = Date.now();
                    const timeSinceLastRequest = now - this.lastRequestTime;
                    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
                        const delay = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    this.lastRequestTime = Date.now();

                    try {
                        const accountData = accountInfo.accountInfo.data;
                        const owner = new PublicKey(accountData.slice(32, 64));
                        
                        if (owner.equals(pubKey)) {
                            const mint = new PublicKey(accountData.slice(0, 32));
                            const amount = accountData.readBigUInt64LE(64);
                            
                            // Fetch recent transactions for this account
                            const signatures = await this.connection.getSignaturesForAddress(
                                owner,
                                { limit: 1 },
                                'confirmed'
                            );

                            const latestTxSignature = signatures[0]?.signature;
                            
                            logger.debug('Detected token transfer', {
                                mint: mint.toString(),
                                amount: amount.toString(),
                                signature: latestTxSignature
                            });

                            // Skip SOL transfers
                            if (mint.toString() === 'So11111111111111111111111111111111111111112') {
                                logger.debug('Skipping SOL transfer');
                                return;
                            }

                            // Check if this is a significant transfer
                            if (amount > BigInt(1000)) {
                                logger.info(`Detected significant token transfer. Token: ${mint.toString()}, Signature: ${latestTxSignature}`);
                                
                                // Fetch and verify transaction status before buying
                                if (latestTxSignature) {
                                    const transaction = await this.connection.getTransaction(latestTxSignature, {
                                        maxSupportedTransactionVersion: 0
                                    });
                                    
                                    if (transaction?.meta?.err) {
                                        logger.debug(`Skipping buy - Original transaction failed: ${latestTxSignature}`);
                                        return;
                                    }
                                    
                                    // Only proceed with buy if transaction was successful
                                    await this.bot.buy(mint);
                                }
                            }
                        }
                    } catch (error) {
                        logger.error(`Error processing transfer: ${error instanceof Error ? error.message : String(error)}`);
                    }
                },
                'confirmed',
                [
                    {
                        memcmp: {
                            offset: 32,
                            bytes: pubKey.toBase58()
                        }
                    }
                ]
            );

            logger.info(`Started tracking transfers for wallet: ${this.targetWallet}`);
            this.isConnected = true;

        } catch (error) {
            logger.error(`Failed to start tracking: ${error instanceof Error ? error.message : String(error)}`);
            await this.handleReconnect();
        }
    }

    private async checkConnection() {
        try {
            await this.connection.getSlot();
            if (!this.isConnected) {
                logger.info('Connection restored, restarting tracking...');
                await this.startTracking();
            }
        } catch (error) {
            logger.warn('Connection check failed, attempting to reconnect...');
            await this.handleReconnect();
        }
    }

    private async handleReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            logger.error('Max reconnection attempts reached. Please restart the bot.');
            process.exit(1);
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff up to 30s
        logger.info(`Attempting to reconnect in ${delay/1000} seconds... (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        await this.startTracking();
    }

    private async analyzeTrade(tx: ParsedTransactionWithMeta) {
        try {
            const instructions = tx.transaction.message.instructions;
            const programIds = instructions.map(ix => ix.programId.toString());
            
            // Known program IDs
            const SYSTEM_PROGRAM = '11111111111111111111111111111111';
            const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
            const DRIFT = 'HQ2UUt18uJqKaQFJhgV9zaTdQxUZjNrsKFgoEDquBkcx';
            
            // Detailed logging for Raydium transactions
            if (programIds.includes(RAYDIUM_AMM)) {
                logger.debug('Detected Raydium transaction');
                
                // Get all token accounts involved
                const postTokenBalances = tx.meta?.postTokenBalances || [];
                const preTokenBalances = tx.meta?.preTokenBalances || [];
                
                logger.debug('Pre-balance tokens:', preTokenBalances.map(b => ({
                    mint: b.mint,
                    amount: b.uiTokenAmount.uiAmount,
                    owner: b.owner
                })));
                
                logger.debug('Post-balance tokens:', postTokenBalances.map(b => ({
                    mint: b.mint,
                    amount: b.uiTokenAmount.uiAmount,
                    owner: b.owner
                })));

                // Look for balance increases
                const increases = postTokenBalances.filter(post => {
                    const pre = preTokenBalances.find(p => p.mint === post.mint);
                    if (!pre) return true; // New token
                    
                    const preAmount = pre.uiTokenAmount.uiAmount || 0;
                    const postAmount = post.uiTokenAmount.uiAmount || 0;
                    return postAmount > preAmount;
                });

                if (increases.length > 0) {
                    logger.info('Detected token balance increases:', increases.map(t => ({
                        mint: t.mint,
                        amount: t.uiTokenAmount.uiAmount
                    })));

                    // Filter for significant changes only
                    const significantIncreases = increases.filter(t => {
                        const amount = t.uiTokenAmount.uiAmount || 0;
                        return amount > 0.001; // Adjust threshold as needed
                    });

                    for (const token of significantIncreases) {
                        if (!token.mint) continue;
                        logger.info(`Detected significant buy on Raydium. Token: ${token.mint}, Amount: ${token.uiTokenAmount.uiAmount}`);
                        await this.bot.buy(new PublicKey(token.mint));
                    }
                }
            }

            // Handle error codes
            if (tx.meta?.err) {
                const error = tx.meta.err as any;
                if (error.InstructionError) {
                    const [index, err] = error.InstructionError;
                    if (err.Custom === 40) {
                        logger.debug('Raydium transaction failed: Slippage tolerance exceeded');
                        return;
                    }
                    if (err.Custom === 30) {
                        logger.debug('Drift transaction failed: Common error (likely liquidation or failed order)');
                        return;
                    }
                }
            }

        } catch (error) {
            logger.error(`Failed to analyze trade: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} 