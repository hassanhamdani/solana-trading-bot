import { Connection, PublicKey, Transaction, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { logger } from './helpers';
import axios from 'axios';
import { API_URLS } from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { fetchAllDigitalAssetByOwner } from '@metaplex-foundation/mpl-token-metadata';

dotenv.config(); // Load environment variables

let ENABLE_BUY = false;  // Control buying (SOL -> Token)
let ENABLE_SELL = true; // Control selling (Token -> SOL)

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second delay between retries
const EMERGENCY_SLIPPAGE_BPS = 5000; // 50% slippage for emergency sells

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

    private async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async executeSwap(
        tokenInMint: string,
        tokenOutMint: string,
        amountIn: number,
        targetWalletAddress?: string,
        isSellingTransaction?: boolean
    ): Promise<string | null> {
        let retryCount = 0;
        const isBuyTransaction = tokenInMint === 'So11111111111111111111111111111111111111112';
        const isSellTransaction = tokenOutMint === 'So11111111111111111111111111111111111111112';

        // Early exit without logging if transaction type is disabled
        if ((isBuyTransaction && !ENABLE_BUY) || (isSellTransaction && !ENABLE_SELL)) {
            return null;
        }

        // Only log swap type if the transaction type is enabled
        logger.info(`Swap Type: ${isBuyTransaction ? 'BUY' : 'SELL'}`);

        while (retryCount <= MAX_RETRIES) {
            try {
                // Add buy/sell control check at the start
                const isBuyTransaction = tokenInMint === 'So11111111111111111111111111111111111111112';
                const isSellTransaction = tokenOutMint === 'So11111111111111111111111111111111111111112';

                // Add swap type logging
                logger.info(`Swap Type: ${isBuyTransaction ? 'BUY' : 'SELL'}`);

                // Early exit if transaction type is disabled
                if ((isBuyTransaction && !ENABLE_BUY) || (isSellTransaction && !ENABLE_SELL)) {
                    logger.info(`Transaction skipped: ${isBuyTransaction ? 'BUY' : 'SELL'} transactions are disabled`);
                    return null;
                }

                // Check if we own the token before attempting to sell
                if (isSellingTransaction) {
                    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                        this.userWallet.publicKey,
                        { mint: new PublicKey(tokenInMint) }
                    );

                    if (!tokenAccounts.value.length) {
                        logger.error(`Cannot execute sell: We don't own token ${tokenInMint}`);
                        return null;
                    }

                    const ourBalance = Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                    if (ourBalance <= 0) {
                        logger.error(`Cannot execute sell: Zero balance for token ${tokenInMint}`);
                        return null;
                    }

                    logger.info(`Found token ${tokenInMint} in our wallet with balance: ${ourBalance}`);
                }

                if (isSellingTransaction && targetWalletAddress) {
                    // Constants for safety checks
                    const MIN_SELL_PERCENTAGE = 1; // Don't sell if less than 1%
                    const MAX_SELL_PERCENTAGE = 100; // Cap at 100%

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
                const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenInMint}&outputMint=${tokenOutMint}&amount=${amountInLamports}&slippageBps=2300&txVersion=V0`;
                
                logger.info(`Fetching quote from: ${swapQuoteUrl}`);
                let swapResponse;

                try {
                    const { data: response } = await axios.get(swapQuoteUrl);
                    // save const { data: response } to swapResponse
                    swapResponse = response;
                    

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
                const computeUnitPrice = String(Math.floor(
                    isSellTransaction 
                        ? (retryCount > 0 ? priorityFeeData.data.default.h : priorityFeeData.data.default.m)  // Use high priority on retry
                        : priorityFeeData.data.default.m / 5  // Buy: Use 1/5 of medium priority
                ));
                logger.info(`Using compute unit price: ${computeUnitPrice} (priority: ${isSellTransaction ? (retryCount > 0 ? 'high' : 'medium') : 'medium/5'}, retry: ${retryCount})`);

                // 3. Build transaction via POST
                const buildTxUrl = `${API_URLS.SWAP_HOST}/transaction/swap-base-in`;
                const isInputSol = tokenInMint === 'So11111111111111111111111111111111111111112';
                const isOutputSol = tokenOutMint === 'So11111111111111111111111111111111111111112';

                // Add validation for token accounts
                let inputTokenAcc, outputTokenAcc;
                if (!isInputSol) {
                    inputTokenAcc = await this.getOrCreateAssociatedTokenAccount(tokenInMint);
                }
                if (!isOutputSol) {
                    outputTokenAcc = await this.getOrCreateAssociatedTokenAccount(tokenOutMint);
                }

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
                    inputAccount: isInputSol ? undefined : inputTokenAcc?.toBase58(),
                    outputAccount: isOutputSol ? undefined : outputTokenAcc?.toBase58(),
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
                retryCount++;
                const transactionType = isBuyTransaction ? 'Buy' : 'Sell';
                
                if (retryCount <= MAX_RETRIES) {
                    logger.warn(`${transactionType} transaction failed, attempt ${retryCount}/${MAX_RETRIES}. Error:`, error);
                    await this.delay(RETRY_DELAY);
                    continue;
                }
                
                logger.error(`${transactionType} transaction failed after ${MAX_RETRIES} attempts:`, error);
                
                // Trigger emergency sell if this was a failed sell transaction
                if (isSellTransaction) {
                    logger.warn('Initiating emergency sell protocol...');
                    this.triggerEmergencySell(tokenInMint).catch(emergencyError => {
                        logger.error('Emergency sell also failed:', emergencyError);
                    });
                }
                
                return null;
            }
        }
        
        return null;
    }

    private async getOrCreateAssociatedTokenAccount(mint: string): Promise<PublicKey> {
        const mintPubkey = new PublicKey(mint);
        const ata = await getAssociatedTokenAddress(mintPubkey, this.userWallet.publicKey);
        
        try {
            await this.connection.getAccountInfo(ata);
            return ata;
        } catch {
            const tx = new Transaction().add(
                createAssociatedTokenAccountInstruction(
                    this.userWallet.publicKey,
                    ata,
                    this.userWallet.publicKey,
                    mintPubkey
                )
            );
            await sendAndConfirmTransaction(this.connection, tx, [this.userWallet]);
            return ata;
        }
    }

    private async triggerEmergencySell(tokenMint: string): Promise<void> {
        try {
            // Get the entire balance of the token
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.userWallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );

            if (!tokenAccounts.value.length) {
                logger.error('Emergency sell: No token account found');
                return;
            }

            const balance = Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            if (balance <= 0) {
                logger.error('Emergency sell: Zero balance');
                return;
            }

            logger.info(`Emergency sell: Attempting to sell entire balance of ${balance} tokens`);

            // Get quote with higher slippage
            const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenMint}&outputMint=So11111111111111111111111111111111111111112&amount=${balance}&slippageBps=${EMERGENCY_SLIPPAGE_BPS}&txVersion=V0`;
            
            const { data: swapResponse } = await axios.get(swapQuoteUrl);

            // Get max priority fees
            const { data: priorityFeeData } = await axios.get(`${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`);
            const computeUnitPrice = String(Math.floor(priorityFeeData.data.default.h)); // Double the high priority fee

            // Build and execute emergency transaction
            const buildTxUrl = `${API_URLS.SWAP_HOST}/transaction/swap-base-in`;
            const { data: swapTransactions } = await axios.post(buildTxUrl, {
                computeUnitPriceMicroLamports: computeUnitPrice,
                swapResponse,
                txVersion: 'V0',
                wallet: this.userWallet.publicKey.toBase58(),
                wrapSol: false,
                unwrapSol: true,
                inputAccount: (await this.getOrCreateAssociatedTokenAccount(tokenMint)).toBase58(),
            });

            if (!swapTransactions.success || !swapTransactions.data) {
                throw new Error('Failed to build emergency swap transaction');
            }

            // Execute the emergency transaction
            for (const tx of swapTransactions.data) {
                const txBuf = Buffer.from(tx.transaction, 'base64');
                const transaction = VersionedTransaction.deserialize(txBuf);
                transaction.sign([this.userWallet]);
                
                const txId = await this.connection.sendTransaction(transaction, {
                    skipPreflight: true,
                    maxRetries: 5
                });

                logger.info(`Emergency sell transaction sent: ${txId}`);
                
                const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction(
                    {
                        blockhash,
                        lastValidBlockHeight,
                        signature: txId,
                    },
                    'confirmed'
                );
                logger.info('Emergency sell transaction confirmed');
            }
        } catch (error) {
            logger.error('Emergency sell failed:', error);
            throw error;
        }
    }

    // Add methods to control BUY/SELL settings
    static enableBuying(enable: boolean) {
        ENABLE_BUY = enable;
        logger.info(`Buying ${enable ? 'enabled' : 'disabled'}`);
    }

    static enableSelling(enable: boolean) {
        ENABLE_SELL = enable;
        logger.info(`Selling ${enable ? 'enabled' : 'disabled'}`);
    }

    // Add helper method to verify transaction success
    public async verifyTransactionSuccess(signature: string): Promise<boolean> {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!tx) {
                logger.error(`Transaction ${signature} not found`);
                return false;
            }

            if (tx.meta?.err) {
                logger.error(`Transaction ${signature} failed with error:`, tx.meta.err);
                return false;
            }

            // Check for specific program errors in logs
            const logs = tx.meta?.logMessages || [];
            const hasError = logs.some(log => 
                log.includes('Error') || 
                log.includes('Failed') || 
                log.includes('Instruction #') || 
                log.includes('Program Error')
            );

            if (hasError) {
                logger.error(`Transaction ${signature} contains error in logs:`, logs);
                return false;
            }

            return true;
        } catch (error) {
            logger.error(`Error verifying transaction ${signature}:`, error);
            return false;
        }
    }
} 