import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { logger } from './helpers';
import { SwapTracker } from './wallet-copier';
import fetch from 'cross-fetch';

interface TradeDetails {
    tokenIn: {
        mint: string;
        amount: number;
    };
    tokenOut: {
        mint: string;
        amount: number;
    };
    signature: string;
    blockhash: string;
    computeUnits: number;
}

export class CopyTradingBot {
    private connection: Connection;
    private targetWallet: string;
    private userWallet: Keypair;
    private swapTracker: SwapTracker;
    private isRunning: boolean = false;
    private readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';
    private readonly JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
    private readonly slippagePercentage = Number(process.env.BUY_SLIPPAGE) || 20; // 20% default slippage for memecoins
    private readonly computeUnitLimit = Number(process.env.COMPUTE_UNIT_LIMIT) || 101337;
    private readonly computeUnitPrice = Number(process.env.COMPUTE_UNIT_PRICE) || 421197;

    constructor(
        connection: Connection,
        targetWallet: string,
        privateKey: string
    ) {
        this.connection = connection;
        this.targetWallet = targetWallet;
        this.userWallet = Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
        this.swapTracker = new SwapTracker(connection, targetWallet);
        
        // Bind the trade handler to this instance
        this.handleTrade = this.handleTrade.bind(this);
    }

    private async getJupiterQuote(inputMint: string, outputMint: string, amount: number): Promise<any> {
        try {
            const endpoint = `${this.JUPITER_QUOTE_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.slippagePercentage * 100}`;
            const response = await fetch(endpoint);
            const data = await response.json();
            return data;
        } catch (error) {
            logger.error(`Error getting Jupiter quote: ${error}`);
            return null;
        }
    }

    private async executeJupiterSwap(quoteResponse: any): Promise<string | null> {
        try {
            // Get swap transaction
            const { swapTransaction } = await (
                await fetch(`${this.JUPITER_QUOTE_API}/swap`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        quoteResponse,
                        userPublicKey: this.userWallet.publicKey.toString(),
                        wrapAndUnwrapSol: true,
                        computeUnitPriceMicroLamports: this.computeUnitPrice,
                        dynamicComputeUnitLimit: true,
                        prioritizationFeeLamports: 'auto'
                    })
                })
            ).json();

            // Deserialize and sign transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.userWallet]);

            // Send transaction
            const rawTransaction = transaction.serialize();
            const signature = await this.connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2
            });

            // Wait for confirmation
            const latestBlockHash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                blockhash: latestBlockHash.blockhash,
                lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                signature
            });

            return signature;

        } catch (error) {
            logger.error(`Error executing Jupiter swap: ${error}`);
            return null;
        }
    }

    private async handleTrade(tx: TradeDetails) {
        try {
            logger.info(`🔄 Copying trade from transaction: ${tx.signature}`);
            
            // Convert amount to lamports/raw amount (multiply by 10^decimals)
            // Note: You'll need to get token decimals from token metadata
            const inputAmount = tx.tokenIn.amount;

            // Get Jupiter quote
            const quoteResponse = await this.getJupiterQuote(
                tx.tokenIn.mint,
                tx.tokenOut.mint,
                inputAmount
            );

            if (!quoteResponse) {
                logger.error('Failed to get Jupiter quote');
                return;
            }

            logger.info('Got Jupiter quote:', {
                inputAmount: quoteResponse.inputAmount,
                outputAmount: quoteResponse.outputAmount,
                priceImpact: quoteResponse.priceImpact,
                platformFee: quoteResponse.platformFee
            });

            // Execute the swap
            const swapSignature = await this.executeJupiterSwap(quoteResponse);
            
            if (swapSignature) {
                logger.info(`✅ Successfully copied trade!`);
                logger.info(`Transaction signature: ${swapSignature}`);
                logger.info(`Solscan: https://solscan.io/tx/${swapSignature}`);
            } else {
                logger.error('Failed to execute swap');
            }

        } catch (error) {
            logger.error(`❌ Error copying trade: ${error}`);
        }
    }

    private parseTrade(txData: any): TradeDetails | null {
        try {
            // Extract token changes
            const tokenChanges = txData.meta.postTokenBalances.map((post: any) => {
                const pre = txData.meta.preTokenBalances.find(
                    (pre: any) => pre.mint === post.mint
                );
                return {
                    mint: post.mint,
                    change: (post.uiTokenAmount.uiAmount || 0) - (pre?.uiTokenAmount.uiAmount || 0)
                };
            });

            // Find the tokens involved in the swap
            const tokenIn = tokenChanges.find((t: any) => t.change < 0);
            const tokenOut = tokenChanges.find((t: any) => t.change > 0);

            if (!tokenIn || !tokenOut) return null;

            return {
                tokenIn: {
                    mint: tokenIn.mint,
                    amount: Math.abs(tokenIn.change)
                },
                tokenOut: {
                    mint: tokenOut.mint,
                    amount: tokenOut.change
                },
                signature: txData.transaction.signatures[0],
                blockhash: txData.transaction.message.recentBlockhash,
                computeUnits: txData.meta.computeUnitsConsumed
            };
        } catch (error) {
            logger.error(`Error parsing trade: ${error}`);
            return null;
        }
    }

    async start() {
        this.isRunning = true;
        logger.info(`🤖 Starting copy trading bot...`);
        logger.info(`Target wallet: ${this.targetWallet}`);
        logger.info(`Your wallet: ${this.userWallet.publicKey.toString()}`);

        // Subscribe to the SwapTracker's events
        // TODO: Implement event emitter in SwapTracker to notify about new trades
        await this.swapTracker.trackSwaps();
    }

    stop() {
        this.isRunning = false;
        this.swapTracker.stop();
        logger.info(`🛑 Stopping copy trading bot...`);
    }
}
