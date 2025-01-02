import { Connection, PublicKey, Transaction, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { logger } from './helpers';
import axios from 'axios';
import { API_URLS } from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { fetchAllDigitalAssetByOwner } from '@metaplex-foundation/mpl-token-metadata';
import { TokenTracker } from './token-tracker';
import fs from 'fs/promises';
import path from 'path';
import { Trade, ITrade } from './db/schema';

dotenv.config(); // Load environment variables

let ENABLE_BUY = false;  // Control buying (SOL -> Token)
let ENABLE_SELL = true; // Control selling (Token -> SOL)

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second delay between retries
const EMERGENCY_SLIPPAGE_BPS = 5000; // 50% slippage for emergency sells
const BASE_SLIPPAGE_BPS = 3000; // 25% base slippage
const MAX_SLIPPAGE_BPS = 4900;  // 49% max slippage
const SLIPPAGE_INCREMENT = 500; // 5% increment per retry
const MAX_ACCEPTABLE_PRICE_IMPACT = 100; // 100%

interface PendingSell {
    mint: string;
    amount: number;
    attempts: number;
    lastAttempt: number;
    targetWallet: string;
}

export class ExtremePriceImpactError extends Error {
    constructor(public priceImpact: number, public mint: string) {
        super(`Extreme price impact of ${priceImpact}% detected for ${mint}`);
        this.name = 'ExtremePriceImpactError';
    }
}

export class SwapService {
    private connection: Connection;
    private userWallet: Keypair;
    private targetWallet: string;
    public tokenTracker: TokenTracker;
    private pendingSells: PendingSell[] = [];
    private readonly PENDING_SELLS_FILE = path.join(__dirname, 'pending-sells.json');
    private readonly MAX_TOTAL_ATTEMPTS = 10;
    private readonly RETRY_INTERVALS = [1000, 2000, 5000, 10000, 30000]; // Increasing delays

    constructor(
        connection: Connection,
        userWallet?: Keypair | string,
        targetWallet?: string
    ) {
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

        // Store target wallet
        this.targetWallet = targetWallet ?? process.env.TARGET_WALLET ?? '';
        if (!this.targetWallet) {
            throw new Error('No target wallet provided in constructor or environment variables');
        }

        // Pass both wallets to TokenTracker
        this.tokenTracker = new TokenTracker(
            connection,
            this.targetWallet,  // Target wallet for tracking
            this
        );
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
                        return null;  // Return here without adding to pending sells
                    }

                    const ourBalance = Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                    if (ourBalance <= 0) {
                        logger.error(`Cannot execute sell: Zero balance for token ${tokenInMint}`);
                        return null;  // Return here without adding to pending sells
                    }

                    logger.info(`Found token ${tokenInMint} in our wallet with balance: ${ourBalance}`);
                }

                if (isSellingTransaction && targetWalletAddress) {
                    // Constants for safety checks
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

                    if (!ourTokenAccounts.value.length) {
                        logger.error('Our wallet has no token account for this token');
                        return null;
                    }

                    // Handle case where target has no token account (complete sell)
                    const targetCurrentBalance = tokenAccounts.value.length
                        ? Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount)
                        : 0;
                    const ourCurrentBalance = Number(ourTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);

                    // Calculate sell percentage
                    const targetSellAmount = amountIn;

                    // If target has completely sold (no token account), sell everything
                    if (tokenAccounts.value.length === 0) {
                        logger.info('Target wallet has no token account - executing full sell');
                        amountIn = ourCurrentBalance;
                    } else {
                        if (targetSellAmount > targetCurrentBalance) {
                            logger.error('Target sell amount exceeds their balance - possible error in input');
                            return null;
                        }

                        let targetSellPercentage = (targetSellAmount / targetCurrentBalance) * 100;
                        // Calculate our sell amount based on target's percentage
                        amountIn = Math.floor((ourCurrentBalance * targetSellPercentage) / 100);
                    }

                    logger.info({
                        targetCurrentBalance,
                        ourCurrentBalance,
                        targetSellAmount,
                        finalSellAmount: amountIn
                    });
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

                // Calculate dynamic slippage based on retry count and whether it's a sell
                const currentSlippage = isSellingTransaction
                    ? Math.min(BASE_SLIPPAGE_BPS + (retryCount * SLIPPAGE_INCREMENT), MAX_SLIPPAGE_BPS)
                    : BASE_SLIPPAGE_BPS;

                logger.info(`Using slippage: ${currentSlippage} bps (${currentSlippage / 100}%) for retry ${retryCount}`);

                // Get quote and check price impact
                const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenInMint}&outputMint=${tokenOutMint}&amount=${amountInLamports}&slippageBps=${currentSlippage}&txVersion=V0`;

                let swapResponse;
                try {
                    const { data: response } = await axios.get(swapQuoteUrl);

                    // If price impact is extreme, throw immediately without retries
                    if (response.data.priceImpactPct > MAX_ACCEPTABLE_PRICE_IMPACT) {
                        logger.warn(`🚨 Extreme price impact detected: ${response.data.priceImpactPct}% for ${tokenInMint}`);
                        logger.warn(`Abandoning token due to unacceptable price impact`);
                        throw new ExtremePriceImpactError(response.data.priceImpactPct, tokenInMint);
                    }

                    swapResponse = response;
                } catch (error) {
                    // Immediately throw ExtremePriceImpactError without retrying
                    if (error instanceof ExtremePriceImpactError) {
                        // Remove from pending sells if it exists
                        this.pendingSells = this.pendingSells.filter(sell => sell.mint !== tokenInMint);
                        await this.savePendingSells();
                        throw error;
                    }
                    throw error;
                }

                // Add exponential backoff between retries
                if (retryCount > 0) {
                    const backoffTime = Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
                    logger.info(`Waiting ${backoffTime}ms before retry ${retryCount}`);
                    await this.delay(backoffTime);
                }

                logger.info(`Fetching quote from: ${swapQuoteUrl}`);

                // 2. Get recommended priority fees
                const { data: priorityFeeData } = await axios.get(`${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`);
                const computeUnitPrice = String(Math.floor(
                    isSellTransaction
                        ? (retryCount > 0 ? priorityFeeData.data.default.h : priorityFeeData.data.default.h / 2)  // Use high priority on retry
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

                // After successful swap, if it's a buy, add to holdings
                if (signatures.length > 0 && !isSellingTransaction && tokenInMint === 'So11111111111111111111111111111111111111112') {
                    // Get the amount of tokens we received
                    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                        this.userWallet.publicKey,
                        { mint: new PublicKey(tokenOutMint) }
                    );

                    if (tokenAccounts.value.length > 0) {
                        const amount = Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                        await this.tokenTracker.addHolding(tokenOutMint, amount);
                    }
                }

                // After successful transaction confirmation, update pending sells
                if (signatures.length > 0) {
                    try {
                        const txIds = signatures.join(',');
                        logger.info(`$$$$$$$$$ Swap completed successfully ${txIds} $$$$$$$$$`);

                        // Calculate tokenOut amount by checking balance change
                        let tokenOutAmount = 0;
                        if (tokenOutMint === 'So11111111111111111111111111111111111111112') {
                            // For SOL, get balance change
                            const balance = await this.connection.getBalance(this.userWallet.publicKey);
                            tokenOutAmount = balance / 1e9; // Convert lamports to SOL
                        } else {
                            // For other tokens, get token account balance
                            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                                this.userWallet.publicKey,
                                { mint: new PublicKey(tokenOutMint) }
                            );
                            if (tokenAccounts.value.length > 0) {
                                tokenOutAmount = Number(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount) /
                                    Math.pow(10, tokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals);
                            }
                        }

                        // Create trade record
                        const trade: Partial<ITrade> = {
                            tokenIn: {
                                mint: tokenInMint,
                                amount: amountIn,
                            },
                            tokenOut: {
                                mint: tokenOutMint,
                                amount: tokenOutAmount,
                            },
                            signature: signatures[0],
                            timestamp: new Date(),
                            targetWallet: this.targetWallet,
                            userWallet: this.userWallet.publicKey.toString(),
                            type: tokenInMint === 'So11111111111111111111111111111111111111112' ? 'BUY' : 'SELL',
                            status: 'SUCCESS',
                            computeUnits: Number(computeUnitPrice),
                            slippage: currentSlippage,
                        };

                        // Save to MongoDB
                        await Trade.create(trade);
                        logger.info('Trade saved to database');

                        return signatures[0];
                    } catch (error) {
                        logger.error('Error saving trade to database:', error);
                        // Still return signature even if database save fails
                        return signatures[0];
                    }
                }

            } catch (error: any) {
                // Create failed trade record
                try {
                    const failedTrade: Partial<ITrade> = {
                        tokenIn: {
                            mint: tokenInMint,
                            amount: amountIn,
                        },
                        tokenOut: {
                            mint: tokenOutMint,
                            amount: 0,
                        },
                        timestamp: new Date(),
                        targetWallet: this.targetWallet,
                        userWallet: this.userWallet.publicKey.toString(),
                        type: tokenInMint === 'So11111111111111111111111111111111111111112' ? 'BUY' : 'SELL',
                        status: 'FAILED',
                    };

                    await Trade.create(failedTrade);
                    logger.info('Failed trade saved to database');
                } catch (dbError) {
                    logger.error('Error saving failed trade to database:', dbError);
                }

                retryCount++;

                // Check specifically for slippage error
                const isSlippageError = error?.response?.data?.message?.includes('slippage') ||
                    error?.message?.includes('Custom:40');

                if (isSlippageError) {
                    logger.warn(`Slippage error detected on attempt ${retryCount}, will retry with higher slippage`);
                    continue;
                }

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

            // Use maximum possible slippage for emergency sells
            const EMERGENCY_MAX_SLIPPAGE = 4900; // 49% - maximum safe value
            const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenMint}&outputMint=So11111111111111111111111111111111111111112&amount=${balance}&slippageBps=${EMERGENCY_MAX_SLIPPAGE}&txVersion=V0`;

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

    private async loadPendingSells(): Promise<void> {
        try {
            const data = await fs.readFile(this.PENDING_SELLS_FILE, 'utf8');
            this.pendingSells = JSON.parse(data);
        } catch (error) {
            this.pendingSells = [];
        }
    }

    private async savePendingSells(): Promise<void> {
        await fs.writeFile(this.PENDING_SELLS_FILE, JSON.stringify(this.pendingSells, null, 2));
    }

    private async processPendingSells(): Promise<void> {
        for (const sell of this.pendingSells) {
            if (Date.now() - sell.lastAttempt > this.RETRY_INTERVALS[Math.min(sell.attempts, this.RETRY_INTERVALS.length - 1)]) {
                try {
                    await this.triggerEmergencySell(sell.mint);
                    this.pendingSells = this.pendingSells.filter(s => s.mint !== sell.mint);
                } catch (error) {
                    sell.attempts++;
                    sell.lastAttempt = Date.now();
                    if (sell.attempts >= this.MAX_TOTAL_ATTEMPTS) {
                        logger.error(`Critical: Failed to sell ${sell.mint} after ${sell.attempts} total attempts`);
                        // Could add notification system here
                    }
                }
                await this.savePendingSells();
            }
        }
    }

    // Add static method to check if buying is enabled
    static isBuyingEnabled(): boolean {
        return ENABLE_BUY;
    }

    // Add static method to check if selling is enabled
    static isSellingEnabled(): boolean {
        return ENABLE_SELL;
    }
} 