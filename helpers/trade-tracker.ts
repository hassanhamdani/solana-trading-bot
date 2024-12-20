import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { logger } from './logger';

export class TradeTracker {
  constructor(
    private readonly connection: Connection,
    private readonly walletAddress: string
  ) {}

  async trackTrades() {
    try {
      const pubKey = new PublicKey(this.walletAddress);
      
      // Subscribe to real-time transactions
      this.connection.onLogs(
        pubKey,
        async (logs) => {
          if (logs.err) return;
          
          const tx = await this.connection.getParsedTransaction(logs.signature, {
            maxSupportedTransactionVersion: 0
          });
          
          if (tx) {
            this.analyzeTrade(tx);
          }
        },
        'confirmed'
      );

      // Get recent transactions
      const signatures = await this.connection.getSignaturesForAddress(pubKey, {
        limit: 20
      });
      
      for (const sig of signatures) {
        const tx = await this.connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0
        });
        if (tx) {
          this.analyzeTrade(tx);
        }
      }

    } catch (error) {
      logger.error('Error tracking trades:', error);
    }
  }

  private analyzeTrade(tx: ParsedTransactionWithMeta) {
    // Look for Raydium AMM program ID
    const isRaydiumTx = tx.transaction.message.instructions.some(
      ix => ix.programId.toString() === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' // Raydium AMM
    );

    if (!isRaydiumTx) return;

    const timestamp = new Date((tx.blockTime || 0) * 1000).toLocaleString();
    
    logger.info({
      timestamp,
      signature: tx.transaction.signatures[0],
      type: 'Raydium Swap',
      url: `https://solscan.io/tx/${tx.transaction.signatures[0]}`
    });
  }
} 