import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getWallet } from './helpers';

const WSOL_MINT = new PublicKey(NATIVE_MINT);
const amount = 0.005 * LAMPORTS_PER_SOL; // Only wrap 0.005 SOL

async function wrapSol() {
    const connection = new Connection(process.env.RPC_ENDPOINT!, 'confirmed');
    const wallet = getWallet(process.env.PRIVATE_KEY!);
    
    try {
        const associatedTokenAccount = await getAssociatedTokenAddress(
            WSOL_MINT,
            wallet.publicKey,
            false,
            TOKEN_PROGRAM_ID
        );

        console.log('Creating WSOL account:', associatedTokenAccount.toString());

        // First check if the account exists
        const accountInfo = await connection.getAccountInfo(associatedTokenAccount);
        
        const transaction = new Transaction();
        
        if (!accountInfo) {
            console.log('Account does not exist, creating...');
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    wallet.publicKey,
                    associatedTokenAccount,
                    wallet.publicKey,
                    WSOL_MINT
                )
            );
        }

        transaction.add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: associatedTokenAccount,
                lamports: amount,
            }),
            createSyncNativeInstruction(associatedTokenAccount)
        );

        const signature = await connection.sendTransaction(transaction, [wallet]);
        await connection.confirmTransaction(signature, 'confirmed');
        
        console.log(`Transaction successful! Signature: ${signature}`);
        
        // Verify the balance
        const balance = await connection.getTokenAccountBalance(associatedTokenAccount);
        console.log(`WSOL Balance after wrap: ${balance.value.uiAmount} WSOL`);

    } catch (error) {
        console.error('Error wrapping SOL:', error);
        if (error instanceof Error) {
            console.error('Details:', error.message);
        }
    }
}

wrapSol(); 