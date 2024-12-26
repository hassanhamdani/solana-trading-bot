import { promises as fs } from 'fs';
import { logger } from '../../helpers';
import path from 'path';

export async function loadAndTrimPoolData() {
    try {
        // Read the original mainnet.json
        const mainnetPath = path.join(process.cwd(), 'data', 'mainnet.json');
        const data = await fs.readFile(mainnetPath, 'utf8');
        const pools = JSON.parse(data);

        // Trim the data to only what we need
        const trimmedPools = pools.map((pool: any) => ({
            id: pool.id,
            baseMint: pool.baseMint,
            quoteMint: pool.quoteMint,
            lpMint: pool.lpMint,
            baseDecimals: pool.baseDecimals,
            quoteDecimals: pool.quoteDecimals,
            lpDecimals: pool.lpDecimals,
            version: pool.version,
            programId: pool.programId,
            authority: pool.authority,
            openOrders: pool.openOrders,
            targetOrders: pool.targetOrders,
            baseVault: pool.baseVault,
            quoteVault: pool.quoteVault,
            withdrawQueue: pool.withdrawQueue,
            lpVault: pool.lpVault,
            marketVersion: pool.marketVersion,
            marketProgramId: pool.marketProgramId,
            marketId: pool.marketId,
            marketAuthority: pool.marketAuthority,
            marketBaseVault: pool.marketBaseVault,
            marketQuoteVault: pool.marketQuoteVault,
            marketBids: pool.marketBids,
            marketAsks: pool.marketAsks,
            marketEventQueue: pool.marketEventQueue
        }));

        // Save the trimmed data
        const trimmedPath = path.join(process.cwd(), 'data', 'trimmed_mainnet.json');
        await fs.writeFile(trimmedPath, JSON.stringify(trimmedPools, null, 2));
        logger.info(`Pool data trimmed and saved to ${trimmedPath}`);
        
        return trimmedPools;
    } catch (error) {
        logger.error('Error processing pool data:', error);
        throw error;
    }
} 