import { Connection, PublicKey, Transaction, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { logger } from './helpers';
import axios from 'axios';
import { API_URLS } from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getMint } from '@solana/spl-token';
import { fetchAllDigitalAssetByOwner } from '@metaplex-foundation/mpl-token-metadata';
import { TokenTracker } from './token-tracker';
import fs from 'fs/promises';
import path from 'path';

dotenv.config(); // Load environment variables

let ENABLE_BUY = false;  // Control buying (SOL -> Token)
let ENABLE_SELL = true; // Control selling (Token -> SOL)

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second delay between retries
const EMERGENCY_SLIPPAGE_BPS = 5000; // 50% slippage for emergency sells
const BASE_SLIPPAGE_BPS = 2300; // 25% base slippage
const MAX_SLIPPAGE_BPS = 4900;  // 49% max slippage
const SLIPPAGE_INCREMENT = 500; // 5% increment per retry
const MAX_ACCEPTABLE_PRICE_IMPACT = 100; // 100%
const MIN_SOL_OUTPUT = 0.000001; // Minimum SOL output threshold

interface PendingSell {
    mint: string;
    amount: number;
    attempts: number;
    lastAttempt: number;
    targetWallet: string;
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
        // Early validation for buy/sell controls
        const isBuyTransaction = tokenInMint === 'So11111111111111111111111111111111111111112';
        const isSellTransaction = tokenOutMint === 'So11111111111111111111111111111111111111112';

        if ((isBuyTransaction && !ENABLE_BUY) || (isSellTransaction && !ENABLE_SELL)) {
            logger.info(`Transaction skipped: ${isBuyTransaction ? 'BUY' : 'SELL'} transactions are disabled`);
            return null;
        }

        // For buys, always use 0.001 SOL (fixed amount)
        if (isBuyTransaction) {
            amountIn = 0.001; // 0.001 SOL
        }

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                // Get decimals based on input token
                let decimals: number;
                if (isBuyTransaction) {
                    decimals = 9; // SOL decimals
                } else {
                    // Find decimals from holdings for sell transactions
                    const holding = this.tokenTracker.holdings.find(h => h.mint === tokenInMint);
                    if (!holding) {
                        throw new Error(`No holding found for token ${tokenInMint}`);
                    }
                    decimals = holding.decimals;
                }

                // Calculate amount with proper decimals
                const adjustedAmountIn = amountIn * Math.pow(10, decimals);

                // Calculate dynamic slippage based on retry attempt
                const currentSlippage = Math.min(
                    BASE_SLIPPAGE_BPS + (attempt * SLIPPAGE_INCREMENT),
                    MAX_SLIPPAGE_BPS
                );

                // Get priority fee based on attempt number
                const { data: priorityFeeData } = await axios.get(`${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`);
                const computeUnitPrice = String(Math.floor(
                    attempt === 0 ? priorityFeeData.data.default.m : priorityFeeData.data.default.h
                ));

                logger.info(`Attempt ${attempt + 1}/${MAX_RETRIES}:`);
                logger.info(`- Amount In: ${amountIn} (${adjustedAmountIn} raw)`);
                logger.info(`- Decimals: ${decimals}`);
                logger.info(`- Slippage: ${currentSlippage/100}%`);
                logger.info(`- Priority: ${attempt === 0 ? 'medium' : 'high'}`);

                // Get quote
                const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenInMint}&outputMint=${tokenOutMint}&amount=${adjustedAmountIn}&slippageBps=${currentSlippage}&txVersion=V0`;
                logger.info(`Fetching swap quote from: ${swapQuoteUrl}`);
                const { data: swapResponse } = await axios.get(swapQuoteUrl);
                // Convert lamports to SOL (1 SOL = 1e9 lamports)
                const expectedSolOutput = Number(swapResponse.data.outputAmount) / 1e9;
                logger.info(`Swap Details:
                - Price Impact: ${swapResponse.data.priceImpactPct}%
                - Expected Output: ${expectedSolOutput} SOL`);

                // Build and execute transaction
                const txId = await this.buildAndExecuteSwap(
                    swapResponse,
                    computeUnitPrice,
                    tokenInMint,
                    tokenOutMint
                );

                if (txId) {
                    logger.info(`Swap successful! Transaction: ${txId}`);
                    return txId;
                }

            } catch (error) {
                const isLastAttempt = attempt === MAX_RETRIES - 1;
                logger.error(`Attempt ${attempt + 1} failed${isLastAttempt ? ' (final attempt)' : ''}:`, error);

                if (!isLastAttempt) {
                    const backoffTime = 1000 * Math.pow(2, attempt);  // Exponential backoff
                    logger.info(`Waiting ${backoffTime}ms before next attempt...`);
                    await this.delay(backoffTime);
                }
            }
        }

        return null;
    }

    // Helper method to build and execute the swap
    private async buildAndExecuteSwap(
        swapResponse: any,
        computeUnitPrice: string,
        tokenInMint: string,
        tokenOutMint: string
    ): Promise<string | null> {
        const isInputSol = tokenInMint === 'So11111111111111111111111111111111111111112';
        const isOutputSol = tokenOutMint === 'So11111111111111111111111111111111111111112';

        // Get or create token accounts
        let inputTokenAcc, outputTokenAcc;
        if (!isInputSol) {
            inputTokenAcc = await this.getOrCreateAssociatedTokenAccount(tokenInMint);
        }
        if (!isOutputSol) {
            outputTokenAcc = await this.getOrCreateAssociatedTokenAccount(tokenOutMint);
        }

        // Build transaction
        const { data: swapTransactions } = await axios.post(`${API_URLS.SWAP_HOST}/transaction/swap-base-in`, {
            computeUnitPriceMicroLamports: computeUnitPrice,
            swapResponse,
            txVersion: 'V0',
            wallet: this.userWallet.publicKey.toBase58(),
            wrapSol: isInputSol,
            unwrapSol: isOutputSol,
            inputAccount: isInputSol ? undefined : inputTokenAcc?.toBase58(),
            outputAccount: isOutputSol ? undefined : outputTokenAcc?.toBase58(),
        });

        if (!swapTransactions.success || !swapTransactions.data) {
            throw new Error('Failed to build swap transaction');
        }

        // Execute transaction
        const txBuf = Buffer.from(swapTransactions.data[0].transaction, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuf);
        transaction.sign([this.userWallet]);

        const signature = await this.connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        // Wait for finalization
        await this.connection.confirmTransaction(
            {
                signature,
                ...(await this.connection.getLatestBlockhash('finalized'))
            },
            'finalized'
        );

        // After successful swap, store token info if it's a buy
        if (tokenOutMint !== 'So11111111111111111111111111111111111111112') {
            const mintInfo = await getMint(this.connection, new PublicKey(tokenOutMint));
            await this.tokenTracker.addHolding(tokenOutMint, swapResponse.data.outputAmount, mintInfo.decimals);
        }

        return signature;
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
            // Wait for finalization
            await this.connection.confirmTransaction(signature, 'finalized');
            
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'finalized',
                maxSupportedTransactionVersion: 0
            });

            if (!tx || tx.meta?.err) {
                logger.error(`Transaction ${signature} failed:`, tx?.meta?.err || 'Transaction not found');
                return false;
            }

            // Check logs for specific error patterns
            const logs = tx.meta?.logMessages || [];
            const errorPatterns = [
                'Error',
                'Failed',
                'Instruction #',
                'Program Error',
                'unknown instruction',
                'Block not finalized'
            ];

            const hasError = logs.some(log => 
                errorPatterns.some(pattern => log.toLowerCase().includes(pattern.toLowerCase()))
            );

            if (hasError) {
                logger.error(`Transaction ${signature} contains errors in logs:`, logs);
                return false;
            }

            return true;
        } catch (error) {
            logger.error(`Error verifying transaction ${signature}:`, error);
            return false;
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