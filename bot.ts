import { Connection, PublicKey, Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';
import { logger } from './helpers';
import { SwapTracker } from './wallet-copier';
import fetch from 'cross-fetch';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import { SwapService } from './swap-service';


export interface TradeDetails {
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
    poolAddress: string;
  }

export class CopyTradingBot {
    private connection: Connection;
    private targetWallet: string;
    private userWallet: Keypair;
    private swapTracker: SwapTracker;
    private isRunning: boolean = false;
    private readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';
    private readonly SOLANA_TRACKER_API = 'https://swap-v2.solanatracker.io/swap';
    private readonly slippagePercentage = Number(process.env.BUY_SLIPPAGE) || 20;
    private readonly computeUnitPrice = Number(process.env.COMPUTE_UNIT_PRICE) || 421197;
    private swapService: SwapService;

    constructor(
        connection: Connection,
        targetWallet: string,
        privateKey: string
    ) {
        this.connection = connection;
        this.targetWallet = targetWallet;
        // Convert base58 private key to Uint8Array
        const bs58 = require('bs58');
        const decodedKey = bs58.decode(privateKey);
        this.userWallet = Keypair.fromSecretKey(decodedKey);
        this.swapTracker = new SwapTracker(connection, targetWallet, this);
        this.swapService = new SwapService(connection, this.userWallet);
        
        // Bind the trade handler to this instance
        this.handleTrade = this.handleTrade.bind(this);
    }

    private async executeSwap(tokenIn: string, tokenOut: string, amount: number, poolAddress?: string): Promise<string | null> {
        return await this.swapService.executeSwap(tokenIn, tokenOut, amount, poolAddress);
    }

    public async handleTrade(tx: TradeDetails) {
        try {
            logger.info(`🔄 Copying trade from transaction: ${tx.signature}`);
            logger.info('Trade details:', JSON.stringify({
                tokenIn: {
                    mint: tx.tokenIn.mint,
                    amount: tx.tokenIn.amount
                },
                tokenOut: {
                    mint: tx.tokenOut.mint
                }
            }, null, 2));
            
            const signature = await this.swapService.executeSwap(
                tx.tokenIn.mint,
                tx.tokenOut.mint,
                tx.tokenIn.amount
            );
            
            if (signature) {
                logger.info(`✅ Successfully copied trade!`);
                logger.info(`Transaction signature: ${signature}`);
                logger.info(`Solscan: https://solscan.io/tx/${signature}`);
            } else {
                logger.error('Failed to execute swap');
            }

        } catch (error) {
            logger.error(`❌ Error copying trade:`, error);
        }
    }

    // private parseTrade(txData: any): TradeDetails | null {
    //     try {
    //         // Extract token changes
    //         const tokenChanges = txData.meta.postTokenBalances.map((post: any) => {
    //             const pre = txData.meta.preTokenBalances.find(
    //                 (pre: any) => pre.mint === post.mint
    //             );
    //             return {
    //                 mint: post.mint,
    //                 change: (post.uiTokenAmount.uiAmount || 0) - (pre?.uiTokenAmount.uiAmount || 0)
    //             };
    //         });

    //         // Find the tokens involved in the swap
    //         const tokenIn = tokenChanges.find((t: any) => t.change < 0);
    //         const tokenOut = tokenChanges.find((t: any) => t.change > 0);

    //         if (!tokenIn || !tokenOut) return null;

    //         // Extract Raydium accounts (you might need to implement this)
    //         const raydiumAccounts = this.extractRaydiumAccounts(txData);
    //         if (!raydiumAccounts) return null;

    //         return {
    //             tokenIn: {
    //                 mint: tokenIn.mint,
    //                 amount: Math.abs(tokenIn.change)
    //             },
    //             tokenOut: {
    //                 mint: tokenOut.mint,
    //                 amount: tokenOut.change
    //             },
    //             signature: txData.transaction.signatures[0],
    //             blockhash: txData.transaction.message.recentBlockhash,
    //             computeUnits: txData.meta.computeUnitsConsumed,
    //             poolAddress: raydiumAccounts.ammId.toString(),
    //             raydiumAccounts
    //         };
    //     } catch (error) {
    //         logger.error(`Error parsing trade: ${error}`);
    //         return null;
    //     }
    // }

    // Add this helper method to extract Raydium accounts
    // private extractRaydiumAccounts(txData: any): RaydiumV4Accounts | null {
    //     try {
    //         const raydiumV4ProgramId = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
            
    //         // Find the Raydium instruction
    //         const raydiumInstruction = txData.transaction.message.compiledInstructions.find(
    //             (ix: any) => txData.transaction.message.staticAccountKeys[ix.programIdIndex].toString() === raydiumV4ProgramId
    //         );

    //         if (!raydiumInstruction) return null;

    //         // Get the account indexes from the instruction
    //         const accounts = raydiumInstruction.accountKeyIndexes;
    //         const staticAccounts = txData.transaction.message.staticAccountKeys;

    //         return {
    //             ammId: new PublicKey(staticAccounts[accounts[1]]),
    //             ammAuthority: new PublicKey(staticAccounts[accounts[2]]),
    //             ammOpenOrders: new PublicKey(staticAccounts[accounts[3]]),
    //             ammTargetOrders: new PublicKey(staticAccounts[accounts[4]]),
    //             poolCoinTokenAccount: new PublicKey(staticAccounts[accounts[5]]),
    //             poolPcTokenAccount: new PublicKey(staticAccounts[accounts[6]]),
    //             serumProgramId: new PublicKey(staticAccounts[accounts[7]]),
    //             serumMarket: new PublicKey(staticAccounts[accounts[8]]),
    //             serumBids: new PublicKey(staticAccounts[accounts[9]]),
    //             serumAsks: new PublicKey(staticAccounts[accounts[10]]),
    //             serumEventQueue: new PublicKey(staticAccounts[accounts[11]]),
    //             serumCoinVaultAccount: new PublicKey(staticAccounts[accounts[12]]),
    //             serumPcVaultAccount: new PublicKey(staticAccounts[accounts[13]]),
    //             serumVaultSigner: new PublicKey(staticAccounts[accounts[14]]),
    //             userSourceTokenAccount: new PublicKey(staticAccounts[accounts[15]]),
    //             userDestTokenAccount: new PublicKey(staticAccounts[accounts[16]]),
    //             userAuthority: new PublicKey(staticAccounts[accounts[17]])
    //         };
    //     } catch (error) {
    //         logger.error(`Error extracting Raydium V4 accounts: ${error}`);
    //         return null;
    //     }
    // }

    async start() {
        this.isRunning = true;
        logger.info(`🤖 Starting copy trading bot...`);
        logger.info(`Target wallet: ${this.targetWallet}`);
        logger.info(`Your wallet: ${this.userWallet.publicKey.toString()}`);


        // Start tracking swaps
        await this.swapTracker.trackSwaps();
    }

    stop() {
        this.isRunning = false;
        // Remove event listener
        this.swapTracker.stop();
        logger.info(`🛑 Stopping copy trading bot...`);
    }
}
