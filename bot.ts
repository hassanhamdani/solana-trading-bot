import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { logger } from './helpers';
import { TransactionExecutor } from './transactions';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { NATIVE_MINT } from '@solana/spl-token';
import axios from 'axios';

export interface BotConfig {
  wallet: Keypair;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  autoBuyDelay: number;
  maxBuyRetries: number;
  buySlippage: number;
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  amount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: unknown;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot: number;
  timeTaken: number;
}

const JUPITER_RATE_LIMIT = 2000; // 2 seconds between requests
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

export class Bot {
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private lastJupiterRequest = 0;
  private readonly jupiterClient = axios.create({
    baseURL: 'https://quote-api.jup.ag/v6',
    timeout: 10000
  });

  constructor(
    private readonly connection: Connection,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;
  }

  async validate() {
    try {
      const balance = await this.connection.getBalance(this.config.wallet.publicKey);
      if (balance <= 0) {
        logger.error(`Insufficient SOL balance in wallet: ${this.config.wallet.publicKey.toString()}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.error(`Failed to validate wallet: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async fetchWithRetry(url: string, options?: RequestInit) {
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        // Rate limiting for Jupiter API
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastJupiterRequest;
        if (timeSinceLastRequest < JUPITER_RATE_LIMIT) {
          await new Promise(resolve => setTimeout(resolve, JUPITER_RATE_LIMIT - timeSinceLastRequest));
        }
        this.lastJupiterRequest = Date.now();

        const response = await fetch(url, options);
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * (i + 1);
          logger.debug(`Rate limited by Jupiter. Retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return response;
      } catch (error) {
        if (i === MAX_RETRIES - 1) throw error;
        logger.debug(`Request failed, retrying... (${error instanceof Error ? error.message : String(error)})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1)));
      }
    }
    throw new Error('Max retries reached');
  }

  public async buy(mint: PublicKey) {
    try {
        // Add validation
        if (!mint) {
            logger.error('Invalid mint address provided');
            return { confirmed: false, error: 'Invalid mint' };
        }

        // Add delay before buy
        logger.debug(`Waiting for ${this.config.autoBuyDelay} ms before buy`, { mint: mint.toString() });
        await new Promise(resolve => setTimeout(resolve, this.config.autoBuyDelay));

        // Get quote first
        const quoteResponse = await this.getQuote(mint);
        if (!quoteResponse || !quoteResponse.data) {
            logger.error('Failed to get quote', { mint: mint.toString() });
            return { confirmed: false, error: 'Quote failed' };
        }

        // Validate quote data
        const { data } = quoteResponse;
        if (!data.swapTransaction) {
            logger.error('No swap transaction in quote', { mint: mint.toString() });
            return { confirmed: false, error: 'Invalid quote' };
        }

        // Execute the swap
        logger.debug('Executing transaction...', { mint: mint.toString() });
        const swapResult = await this.executeSwap(data.swapTransaction);

        if (swapResult.confirmed) {
            logger.info('Buy transaction confirmed', { 
                mint: mint.toString(),
                signature: swapResult.signature 
            });
        } else {
            logger.error('Buy transaction failed', { 
                mint: mint.toString(),
                error: swapResult.error 
            });
        }

        return swapResult;

    } catch (error) {
        logger.error('Error in buy function', {
            mint: mint?.toString(),
            error: error instanceof Error ? error.message : String(error)
        });
        return { confirmed: false, error: String(error) };
    }
  }

  private async getQuote(mint: PublicKey): Promise<any> {
    const inputMint = NATIVE_MINT.toString();
    const outputMint = mint.toString();
    // Ensure minimum amount of 0.001 SOL (1,000,000 lamports)
    const minAmount = 1_000_000;
    const amount = Math.max(minAmount, this.config.quoteAmount.raw.toNumber());
    const slippage = this.config.buySlippage;

    try {
        logger.info('Preparing quote request:', {
            inputMint,
            outputMint,
            amount: amount.toString(),
            slippage,
            amountInSOL: amount / 1e9
        });

        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`;
        logger.info('Requesting quote from:', { url: quoteUrl });

        const quoteResponse = await this.fetchWithRetry(quoteUrl);
        const quoteData = await quoteResponse.json();

        console.log('Full Quote Response:', JSON.stringify(quoteData, null, 2));

        // Prepare swap request
        const swapRequestBody = {
            quoteResponse: quoteData,
            userPublicKey: this.config.wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            computeUnitPriceMicroLamports: 1000,
            prioritizationFeeLamports: 1000,
            slippageBps: slippage,
            strict: false
        };

        console.log('Swap Request Body:', JSON.stringify(swapRequestBody, null, 2));

        const swapResponse = await this.fetchWithRetry('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(swapRequestBody)
        });
        
        const swapData = await swapResponse.json();
        
        // Log the complete swap response
        console.log('Complete Swap Response:', JSON.stringify(swapData, null, 2));
        
        logger.info('Swap Response:', { 
            status: swapResponse.status,
            hasSwapTransaction: !!swapData.swapTransaction,
            error: swapData.error,
            message: swapData.message,
            responseKeys: Object.keys(swapData)
        });

        if (!swapData.swapTransaction) {
            logger.error('No swap transaction in response', { 
                status: swapResponse.status,
                error: swapData.error,
                message: swapData.message,
                data: swapData
            });
            return null;
        }

        return { data: swapData };

    } catch (error) {
        logger.error('Error in getQuote:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            params: {
                inputMint,
                outputMint,
                amount,
                slippage
            }
        });
        return null;
    }
  }

  private async executeSwap(swapTransaction: string): Promise<{ confirmed: boolean; signature: string; error?: string }> {
    try {
        // Decode and deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        // Sign the transaction with our wallet
        transaction.sign([this.config.wallet]);

        logger.debug('Executing transaction...');
        
        // Get the latest blockhash
        const latestBlockHash = await this.connection.getLatestBlockhash();

        // Send the transaction
        const rawTransaction = transaction.serialize();
        const signature = await this.connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        logger.debug('Confirming transaction...', { signature });

        // Wait for confirmation
        const confirmation = await this.connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature
        });

        if (confirmation.value.err) {
            logger.error('Transaction confirmed but failed', {
                error: confirmation.value.err,
                signature
            });
            return {
                confirmed: false,
                signature,
                error: JSON.stringify(confirmation.value.err)
            };
        }

        return {
            confirmed: true,
            signature
        };

    } catch (error) {
        logger.error('Error executing swap', {
            error: error instanceof Error ? error.message : String(error)
        });
        return {
            confirmed: false,
            signature: '',
            error: String(error)
        };
    }
  }
}