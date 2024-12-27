import { Connection, PublicKey, Transaction, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { logger } from './helpers';
import axios from 'axios';
import { API_URLS } from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables

export class SwapService {
    private connection: Connection;
    private userWallet: Keypair;

    constructor(connection: Connection, userWallet?: Keypair | string) {
        this.connection = connection;
        
        // Use environment variable if no wallet is provided
        const privateKey = userWallet || process.env.PRIVATE_KEY;
        
        if (!privateKey) {
            throw new Error('No private key provided in constructor or environment variables');
        }

        if (typeof privateKey === 'string') {
            try {
                const privateKeyBytes = bs58.decode(privateKey);
                this.userWallet = Keypair.fromSecretKey(privateKeyBytes);
                logger.info(`Wallet initialized with public key: ${this.userWallet.publicKey.toString()}`);
            } catch (error) {
                logger.error(`Failed to create Keypair from private key: ${error}`);
                throw error;
            }
        } else {
            this.userWallet = privateKey;
            logger.info(`Wallet initialized from provided Keypair: ${this.userWallet.publicKey.toString()}`);
        }
    }

    async executeSwap(
        tokenInMint: string,
        tokenOutMint: string,
        amountIn: number,
        targetWalletAddress?: string,
        isSellingTransaction?: boolean
    ): Promise<string | null> {
        try {
            if (isSellingTransaction && targetWalletAddress) {
                // Constants for safety checks
                const MIN_SELL_PERCENTAGE = 1; // Don't sell if less than 1%
                const MAX_SELL_PERCENTAGE = 100; // Cap at 100%
                const MIN_TRANSACTION_VALUE_SOL = 0.001; // Minimum transaction value in SOL

                // Get target wallet's balance
                const targetWalletPubkey = new PublicKey(targetWalletAddress);
                const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                    targetWalletPubkey,
                    { mint: new PublicKey(tokenInMint) }
                );

                // Get our wallet's balance
                const ourTokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                    this.userWallet.publicKey,
                    { mint: new PublicKey(tokenInMint) }
                );

                // Safety checks
                if (!tokenAccounts.value.length) {
                    logger.error('Target wallet has no token account for this token');
                    return null;
                }

                if (!ourTokenAccounts.value.length) {
                    logger.error('Our wallet has no token account for this token');
                    return null;
                }

                const targetCurrentBalance = Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                const ourCurrentBalance = Number(ourTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);

                // Validate balances
                if (targetCurrentBalance <= 0) {
                    logger.error('Target wallet has zero balance');
                    return null;
                }

                if (ourCurrentBalance <= 0) {
                    logger.error('Our wallet has zero balance');
                    return null;
                }

                // Calculate sell percentage
                const targetSellAmount = amountIn;
                if (targetSellAmount > targetCurrentBalance) {
                    logger.error('Target sell amount exceeds their balance - possible error in input');
                    return null;
                }

                let targetSellPercentage = (targetSellAmount / targetCurrentBalance) * 100;

                // Apply safety thresholds
                if (targetSellPercentage < MIN_SELL_PERCENTAGE) {
                    logger.warn(`Sell percentage (${targetSellPercentage.toFixed(2)}%) below minimum threshold, skipping`);
                    return null;
                }

                if (targetSellPercentage > MAX_SELL_PERCENTAGE) {
                    logger.warn(`Sell percentage capped from ${targetSellPercentage.toFixed(2)}% to ${MAX_SELL_PERCENTAGE}%`);
                    targetSellPercentage = MAX_SELL_PERCENTAGE;
                }

                // Calculate our sell amount
                let ourSellAmount = (ourCurrentBalance * targetSellPercentage) / 100;

                // Get token price in SOL for minimum value check
                try {
                    const { data: priceData } = await axios.get(
                        `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenInMint}&outputMint=${tokenOutMint}&amount=${Math.floor(ourSellAmount)}&slippageBps=1000`
                    );
                    
                    const expectedSolOutput = priceData.outputAmount / 1e9; // Convert lamports to SOL
                    
                    if (expectedSolOutput < MIN_TRANSACTION_VALUE_SOL) {
                        logger.warn(`Transaction value (${expectedSolOutput} SOL) below minimum threshold, skipping`);
                        return null;
                    }
                } catch (error) {
                    logger.error('Failed to check minimum transaction value:', error);
                    return null;
                }

                // Round to appropriate decimal places based on token decimals
                const tokenDecimals = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals;
                ourSellAmount = Math.floor(ourSellAmount); // Ensure we have a whole number of base units

                logger.info({
                    targetCurrentBalance,
                    ourCurrentBalance,
                    targetSellAmount,
                    targetSellPercentage: targetSellPercentage.toFixed(2) + '%',
                    ourSellAmount,
                    tokenDecimals
                });

                // Update amountIn for the actual swap
                amountIn = ourSellAmount;
            }

            logger.info(`Attempting swap via Raydium API:`);
            logger.info(`Token In: ${tokenInMint}`);
            logger.info(`Token Out: ${tokenOutMint}`);
            
            // If buying token with SOL, set minimum amount to 0.01 SOL
            const minimumSolAmount = 0.001;
            if (tokenInMint === 'So11111111111111111111111111111111111111112') {
                amountIn = minimumSolAmount;
                logger.info(`Setting minimum SOL amount to: ${minimumSolAmount} SOL`);
            }
            
            // Convert SOL to lamports (1 SOL = 1e9 lamports)
            const amountInLamports = Math.floor(amountIn * 1e9);
            logger.info(`Amount In (SOL): ${amountIn}`);
            logger.info(`Amount In (lamports): ${amountInLamports}`);

            // 1. Get quote from Raydium API
            const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenInMint}&outputMint=${tokenOutMint}&amount=${amountInLamports}&slippageBps=1000&txVersion=V0`;
            
            logger.info(`Fetching quote from: ${swapQuoteUrl}`);
            let swapResponse;

            try {
                const { data: response } = await axios.get(swapQuoteUrl);
                // save const { data: response } to swapResponse
                swapResponse = response;
                
                // // Log the complete response for debugging
                // logger.info('Complete API Response:', {
                //     status: response.status,
                //     statusText: response.statusText,
                //     data: JSON.stringify(response.data, null, 2)
                // });

                // // Validate specific expected properties
                // if (!swapResponse.inputAmount) {
                //     logger.error('Invalid response structure:', swapResponse);
                //     throw new Error('Invalid response structure from Raydium API');
                // }

                // // Log the specific swap details we received
                // logger.info('Swap Quote Details:', {
                //     inputAmount: swapResponse.inputAmount,
                //     outputAmount: swapResponse.outputAmount,
                //     priceImpact: swapResponse.priceImpactPct,
                //     slippage: swapResponse.slippageBps
                // });

            } catch (quoteError: any) {
                logger.error('Quote Error Details:', {
                    message: quoteError.message,
                    status: quoteError.response?.status,
                    statusText: quoteError.response?.statusText,
                    responseData: quoteError.response?.data,
                    url: swapQuoteUrl
                });
                throw quoteError;
            }

            // 2. Get recommended priority fees
            const { data: priorityFeeData } = await axios.get(`${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`);
            const computeUnitPrice = String(Math.floor(priorityFeeData.data.default.m / 5)); // Using 1/5 of medium priority fee
            logger.info(`Using compute unit price: ${computeUnitPrice} (priority: medium, divided by 5)`);

            // 3. Build transaction via POST
            const buildTxUrl = `${API_URLS.SWAP_HOST}/transaction/swap-base-in`;
            const isInputSol = tokenInMint === 'So11111111111111111111111111111111111111112';
            const isOutputSol = tokenOutMint === 'So11111111111111111111111111111111111111112';

            const { data: swapTransactions } = await axios.post<{
                id: string;
                version: string;
                success: boolean;
                data: { transaction: string }[];
            }>(`${API_URLS.SWAP_HOST}/transaction/swap-base-in`, {
                computeUnitPriceMicroLamports: computeUnitPrice,
                swapResponse,
                txVersion: 'V0',
                wallet: this.userWallet.publicKey.toBase58(),
                wrapSol: isInputSol,
                unwrapSol: isOutputSol,
                inputAccount: isInputSol ? undefined : undefined,
                outputAccount: isOutputSol ? undefined : undefined,
            });

            // Add detailed logging of the response
            logger.info('Build transaction response:', JSON.stringify(swapTransactions, null, 2));

            if (!swapTransactions.success || !swapTransactions.data) {
                throw new Error('Failed to build swap transaction');
            }

            // 4. Process transactions with better error handling and logging
            const allTxBuf = swapTransactions.data.map(tx => 
                Buffer.from(tx.transaction, 'base64')
            );

            logger.info(`Transaction version from Raydium: ${swapTransactions.version}`);
            const signatures: string[] = [];

            // Helper function to safely parse transactions
            const parseTx = (buf: Buffer) => {
                try {
                    return VersionedTransaction.deserialize(buf);
                } catch (e) {
                    logger.warn('Failed to parse as VersionedTransaction, falling back to Legacy Transaction');
                    return Transaction.from(buf);
                }
            };

            // Parse and process each transaction
            const allTransactions = allTxBuf.map(buf => parseTx(buf));

            let idx = 0;
            for (const tx of allTransactions) {
                idx++;
                logger.info(`Processing transaction ${idx}/${allTransactions.length}`);

                try {
                    if (tx instanceof VersionedTransaction) {
                        tx.sign([this.userWallet]);
                        
                        const txId = await this.connection.sendTransaction(tx, {
                            skipPreflight: true,
                            maxRetries: 3
                        });
                        signatures.push(txId);

                        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash({
                            commitment: 'finalized'
                        });

                        logger.info(`Versioned transaction ${idx} sending..., txId: ${txId}`);
                        await this.connection.confirmTransaction(
                            {
                                blockhash,
                                lastValidBlockHeight,
                                signature: txId,
                            },
                            'confirmed'
                        );
                        logger.info(`Versioned transaction ${idx} confirmed`);
                    } else {
                        const txId = await sendAndConfirmTransaction(
                            this.connection,
                            tx as Transaction,
                            [this.userWallet],
                            {
                                skipPreflight: true,
                                maxRetries: 3
                            }
                        );
                        signatures.push(txId);
                        logger.info(`Legacy transaction ${idx} confirmed, txId: ${txId}`);
                    }
                } catch (txError) {
                    logger.error(`Error processing transaction ${idx}:`, txError);
                    throw txError;
                }
            }

            return signatures.join(',');

        } catch (error) {
            logger.error('Error executing swap:', error);
            if (error) {
                logger.error('API Error details:', JSON.stringify(error, null, 2));
            }
            return null;
        }
    }
} 