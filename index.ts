import { Connection } from '@solana/web3.js';
import { logger, COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, LOG_LEVEL } from './helpers';
import { SwapTracker } from './wallet-copier';

const connection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    commitment: COMMITMENT_LEVEL,
    confirmTransactionInitialTimeout: 60000,
    httpHeaders: {
        'Cache-Control': 'no-cache',
    },
});

const runSwapTracker = async () => {
    logger.level = LOG_LEVEL;
    logger.info('Swap tracker is starting...');

    const walletToTrack = '5iywveQKkidqPDKt2CExJcWKex2EXz9kbGcYiZvhuXWs';
    logger.info(`Starting to track wallet: ${walletToTrack}`);

    const tracker = new SwapTracker(connection, walletToTrack);
    await tracker.trackSwaps();

    logger.info('Swap tracker is running! Press CTRL + C to stop it.');
};

runSwapTracker();
