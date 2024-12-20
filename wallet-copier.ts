import { Connection, ParsedTransactionWithMeta, PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import { Bot } from './bot';
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID } from '@raydium-io/raydium-sdk';
import { logger } from './helpers';

export class WalletCopier {
    private lastRequestTime = 0;
    private readonly MIN_REQUEST_INTERVAL = 1000; // 1 seconds between requests

    constructor(
        private readonly connection: Connection,
        private readonly bot: Bot,
        private readonly targetWallet: string
    ) {}

    async trackTrades() {
        const pubKey = new PublicKey(this.targetWallet);
        
        this.connection.onLogs(
            pubKey,
            async (logs) => {
                if (logs.err) return;
                
                // Add rate limiting
                const now = Date.now();
                const timeSinceLastRequest = now - this.lastRequestTime;
                if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
                    await new Promise(resolve => setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest));
                }
                this.lastRequestTime = Date.now();
                
                const tx = await this.connection.getParsedTransaction(logs.signature, {
                    maxSupportedTransactionVersion: 0
                });
                
                if (tx) {
                    await this.analyzeTrade(tx);
                }
            },
            'confirmed'
        );

        logger.info(`Started tracking wallet: ${this.targetWallet}`);
    }

    private async analyzeTrade(tx: ParsedTransactionWithMeta) {
        try {
            // Only look for Raydium swaps from target wallet
            const isRaydiumSwap = tx.transaction.message.instructions.some(
                ix => ix.programId.toString() === MAINNET_PROGRAM_ID.AmmV4.toString()
            );

            if (!isRaydiumSwap) return;

            const poolAccount = tx.transaction.message.instructions.find(
                ix => ix.programId.toString() === MAINNET_PROGRAM_ID.AmmV4.toString()
            ) as PartiallyDecodedInstruction;

            if (!poolAccount?.accounts?.[0]) return;

            const accountInfo = await this.connection.getAccountInfo(new PublicKey(poolAccount.accounts[0]));
            if (!accountInfo?.data) return;

            const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
            
            logger.info(`Detected trade from ${this.targetWallet}. Attempting to copy...`);
            await this.bot.buy(new PublicKey(poolAccount.accounts[0]), poolState);
            
            logger.info(`Successfully copied trade: ${tx.transaction.signatures[0]}`);
        } catch (error) {
            logger.error(`Failed to copy trade: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} 