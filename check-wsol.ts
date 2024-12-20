import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, NATIVE_MINT } from '@solana/spl-token';
import { getWallet } from './helpers';

async function checkWSOL() {
    const connection = new Connection(process.env.RPC_ENDPOINT!, 'confirmed');
    const wallet = getWallet(process.env.PRIVATE_KEY!);
    
    try {
        const wsolMint = new PublicKey(NATIVE_MINT);
        const wsolAccount = await getAssociatedTokenAddress(
            wsolMint,
            wallet.publicKey
        );

        console.log('WSOL Account:', wsolAccount.toString());
        
        const balance = await connection.getTokenAccountBalance(wsolAccount);
        console.log('WSOL Balance:', balance.value.uiAmount);

    } catch (error) {
        console.error('Error:', error);
    }
}

checkWSOL(); 