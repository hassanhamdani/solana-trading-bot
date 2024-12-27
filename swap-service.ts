import { Connection, PublicKey, Transaction, Keypair, VersionedTransaction } from '@solana/web3.js';
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
        poolAddress?: string,
    ): Promise<string | null> {
        try {
            logger.info(`Attempting swap via Raydium API:`);
            logger.info(`Token In: ${tokenInMint}`);
            logger.info(`Token Out: ${tokenOutMint}`);
            
            // Convert SOL to lamports (1 SOL = 1e9 lamports)
            const amountInLamports = Math.floor(amountIn * 1e9);
            logger.info(`Amount In (SOL): ${amountIn}`);
            logger.info(`Amount In (lamports): ${amountInLamports}`);

            // 1. Get quote from Raydium API
            const swapQuoteUrl = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${tokenInMint}&outputMint=${tokenOutMint}&amount=${amountInLamports}&slippageBps=20&txVersion=V0`;
            
            logger.info(`Fetching quote from: ${swapQuoteUrl}`);
            let swapResponse;

            try {
                const response = await axios.get(swapQuoteUrl);
                swapResponse = response.data; // Save the response
                
                // Log the complete response for debugging
                logger.info('Complete API Response:', {
                    status: response.status,
                    statusText: response.statusText,
                    data: JSON.stringify(response.data, null, 2)
                });

                // Check if response has data property
                if (!swapResponse) {
                    throw new Error('No data received from Raydium API');
                }

                // Validate specific expected properties
                if (!swapResponse.amountIn) {
                    logger.error('Invalid response structure:', swapResponse);
                    throw new Error('Invalid response structure from Raydium API');
                }

                // Log the specific swap details we received
                logger.info('Swap Quote Details:', {
                    amountIn: swapResponse.amountIn,
                    amountOut: swapResponse.amountOut,
                    priceImpact: swapResponse.priceImpact,
                    fee: swapResponse.fee
                });

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
            const computeUnitPrice = String(priorityFeeData.data.default.h); // Using 'high' priority
            logger.info(`Using compute unit price: ${computeUnitPrice}`);

            // 3. Build transaction via POST
            const buildTxUrl = `${API_URLS.SWAP_HOST}/transaction/swap-base-in`;
            const { data: swapTransactions } = await axios.post(buildTxUrl, {
                computeUnitPriceMicroLamports: computeUnitPrice,
                swapResponse,
                txVersion: 'V0',
                wallet: this.userWallet.publicKey.toBase58(),
                wrapSol: tokenInMint === 'So11111111111111111111111111111111111111112',
                unwrapSol: tokenOutMint === 'So11111111111111111111111111111111111111112',
            });

            // 4. Process transactions
            const allTxBuf = swapTransactions.data.map((tx: any) => 
                Buffer.from(tx.transaction, 'base64')
            );
            const isV0 = swapTransactions.version === 'V0';

            // Track all signatures for return value
            const signatures: string[] = [];

            // 5. Process each transaction
            for (let i = 0; i < allTxBuf.length; i++) {
                const txBuf = allTxBuf[i];
                const tx = isV0 
                    ? VersionedTransaction.deserialize(txBuf)
                    : Transaction.from(txBuf);

                if (isV0) {
                    (tx as VersionedTransaction).sign([this.userWallet]);
                    const txId = await this.connection.sendTransaction(tx as VersionedTransaction, {
                        skipPreflight: false,
                        maxRetries: 3
                    });
                    signatures.push(txId);

                    // Confirm transaction
                    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
                    await this.connection.confirmTransaction({
                        blockhash,
                        lastValidBlockHeight,
                        signature: txId
                    });
                    logger.info(`Transaction ${i + 1}/${allTxBuf.length} confirmed: ${txId}`);
                } else {
                    (tx as Transaction).sign(this.userWallet);
                    const txId = await this.connection.sendTransaction(tx as Transaction, [this.userWallet], {
                        skipPreflight: false,
                        maxRetries: 3
                    });
                    signatures.push(txId);
                    
                    await this.connection.confirmTransaction(txId, 'confirmed');
                    logger.info(`Transaction ${i + 1}/${allTxBuf.length} confirmed: ${txId}`);
                }
            }

            // Return the first signature (or concatenated signatures if multiple)
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