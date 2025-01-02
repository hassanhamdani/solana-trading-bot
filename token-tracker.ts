import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './helpers';
import { promises as fs } from 'fs';
import path from 'path';
import { SwapService } from './swap-service';

interface TokenHolding {
    mint: string;
    amount: number;
    targetAmount: number;
    lastChecked: number;
}

export class TokenTracker {
    private connection: Connection;
    private targetWallet: string;
    private swapService: SwapService;
    public holdings: TokenHolding[] = [];
    private isTracking: boolean = false;
    private readonly HOLDINGS_FILE = path.join(__dirname, 'holdings.json');
    private readonly CHECK_INTERVAL = 5000; // Check every 5 seconds instead of 1
    private readonly HEARTBEAT_INTERVAL = 30000; // 60 seconds for heartbeat instead of 30

    // Add caching to reduce duplicate RPC calls
    private balanceCache: Map<string, { balance: number, timestamp: number }> = new Map();
    private readonly CACHE_TTL = 3000; // 3 second cache lifetime

    constructor(connection: Connection, targetWallet: string, swapService: SwapService) {
        this.connection = connection;
        this.targetWallet = targetWallet;
        this.swapService = swapService;
        this.loadHoldings();
    }

    private async loadHoldings(): Promise<void> {
        try {
            const data = await fs.readFile(this.HOLDINGS_FILE, 'utf8');
            this.holdings = JSON.parse(data);
        } catch (error) {
            logger.info('No existing holdings file found, starting fresh');
            this.holdings = [];
        }
    }

    public async saveHoldings(): Promise<void> {
        await fs.writeFile(this.HOLDINGS_FILE, JSON.stringify(this.holdings, null, 2));
    }

    public async addHolding(mint: string, amount: number): Promise<void> {
        // Get mint info to find decimals
        const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint));
        const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
        
        // Convert the raw amount to decimal-adjusted amount
        const adjustedAmount = amount / Math.pow(10, decimals);
        
        this.holdings.push({
            mint,
            amount: adjustedAmount,
            targetAmount: 0,
            lastChecked: Date.now()
        });
        await this.saveHoldings();
        logger.info(`Added new holding: ${mint} with amount ${adjustedAmount}`);
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public async startTracking(): Promise<void> {
        this.isTracking = true;
        logger.info('Starting token balance tracking...');
        
        // Add heartbeat interval
        const heartbeatInterval = setInterval(() => {
            if (!this.isTracking) {
                clearInterval(heartbeatInterval);
                return;
            }
            this.logHoldingsComparison();
        }, this.HEARTBEAT_INTERVAL);
        
        // Main tracking loop
        while (this.isTracking) {
            try {
                await this.checkBalances();
                // Add a small delay between checks to prevent overwhelming the RPC
                await this.sleep(this.CHECK_INTERVAL);
            } catch (error) {
                logger.error('Error in balance tracking:', error);
                await this.sleep(1000); // Wait a bit longer on error
            }
        }

        // Cleanup on stop
        clearInterval(heartbeatInterval);
    }

    private async getTokenBalance(mint: string, owner: PublicKey): Promise<number> {
        const cacheKey = `${mint}-${owner.toString()}`;
        const cached = this.balanceCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.balance;
        }

        // Get mint info to find decimals
        const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint));
        const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;

        const accounts = await this.connection.getParsedTokenAccountsByOwner(
            owner,
            { mint: new PublicKey(mint) }
        );

        const rawBalance = accounts.value.length 
            ? Number(accounts.value[0].account.data.parsed.info.tokenAmount.amount)
            : 0;

        // Convert from raw to actual token amount
        const balance = rawBalance / Math.pow(10, decimals);

        this.balanceCache.set(cacheKey, {
            balance,
            timestamp: Date.now()
        });

        return balance;
    }

    private async checkBalances(): Promise<void> {
        if (this.holdings.length === 0) return;

        const targetPubkey = new PublicKey(this.targetWallet);
        
        for (const holding of this.holdings) {
            if (!this.isTracking) break;  // Allow clean shutdown

            try {
                const targetBalance = await this.getTokenBalance(
                    holding.mint,
                    targetPubkey
                );
                
                // Only handle sell signals
                if (targetBalance < holding.targetAmount) {
                    logger.info('\n📉 Sell Signal Detected:');
                    logger.info('------------------------');
                    
                    // Check if target has sold their position completely
                    if (targetBalance === 0 && holding.targetAmount > 0) {
                        logger.info(`Detected complete sell of ${holding.mint} by target wallet`);
                        await this.handleFullSell(holding);
                        continue;
                    }
                    
                    // Handle partial sells
                    const sellPercentage = (holding.targetAmount - targetBalance) / holding.targetAmount * 100;
                    logger.info(`Detected ${sellPercentage.toFixed(2)}% decrease in target's ${holding.mint} holdings`);
                    
                    await this.swapService.executeSwap(
                        holding.mint,
                        'So11111111111111111111111111111111111111112', // SOL
                        holding.amount * (sellPercentage / 100),
                        this.targetWallet,
                        true
                    );

                    holding.amount = Math.max(0, holding.amount - (holding.amount * (sellPercentage / 100)));
                    logger.info('------------------------\n');
                }

                holding.targetAmount = targetBalance;
                holding.lastChecked = Date.now();
                await this.saveHoldings();
            } catch (error) {
                logger.error(`Error checking balance for ${holding.mint}:`, error);
            }

            // Sleep 500ms before checking the next token
            await this.sleep(500);
        }
    }

    private async handleFullSell(holding: TokenHolding): Promise<void> {
        try {
            // Check our balance first
            const ourBalance = await this.getTokenBalance(
                holding.mint,
                this.swapService['userWallet'].publicKey
            );

            // If we have no balance, just remove from holdings and return
            if (ourBalance <= 0) {
                logger.info(`No balance found for ${holding.mint}, removing from holdings`);
                this.holdings = this.holdings.filter(h => h.mint !== holding.mint);
                await this.saveHoldings();
                return;
            }

            const txId = await this.swapService.executeSwap(
                holding.mint,
                'So11111111111111111111111111111111111111112',
                holding.amount,
                this.targetWallet,
                true
            );

            if (txId && await this.swapService.verifyTransactionSuccess(txId)) {
                this.holdings = this.holdings.filter(h => h.mint !== holding.mint);
                await this.saveHoldings();
                logger.info(`✅ Successfully verified and removed holding of ${holding.mint}`);
                logger.info(`Transaction verified: https://solscan.io/tx/${txId}`);
            }
        } catch (error) {
            logger.error(`Failed to execute full sell for ${holding.mint}:`, error);
        }
    }

    private async logHoldingsComparison(): Promise<void> {
        logger.info('💗 Token tracker heartbeat - Holdings comparison:');
        const targetPubkey = new PublicKey(this.targetWallet);

        for (const holding of this.holdings) {
            try {
                // Get target's balance
                const targetBalance = await this.getTokenBalance(
                    holding.mint,
                    targetPubkey
                );

                logger.info(`Token ${holding.mint}:`);
                logger.info(`  My holdings: ${holding.amount}`);
                logger.info(`  Target holdings: ${targetBalance}`);
            } catch (error) {
                logger.error(`Error fetching balance comparison for ${holding.mint}:`, error);
            }
        }
    }

    public stop(): void {
        this.isTracking = false;
        logger.info('Stopping token balance tracking...');
    }
} 