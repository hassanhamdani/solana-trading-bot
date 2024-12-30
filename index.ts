import './server';
import { Connection } from '@solana/web3.js';
import { logger, COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, LOG_LEVEL } from './helpers';
import { SwapTracker } from './wallet-copier';
import { CopyTradingBot as Bot } from './bot';

const connection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    commitment: COMMITMENT_LEVEL,
    confirmTransactionInitialTimeout: 60000,
    httpHeaders: {
        'Cache-Control': 'no-cache',
    },
});

// Add connection check
const checkConnection = async () => {
    try {
        await connection.getLatestBlockhash();
        logger.info('RPC connection established successfully');
    } catch (error) {
        logger.error('Failed to connect to RPC:', error);
        process.exit(1);
    }
};

const runSwapTracker = async () => {
    await checkConnection();
    logger.level = LOG_LEVEL;
    logger.info('Swap tracker is starting...');

    const walletToTrack = '5iywveQKkidqPDKt2CExJcWKex2EXz9kbGcYiZvhuXWs';
    logger.info(`Starting to track wallet: ${walletToTrack}`);

    const privateKey = process.env.PRIVATE_KEY || '';
    const bot = new Bot(connection, walletToTrack, privateKey);
    
    // Start the bot instead of directly starting the tracker
    await bot.start();

    logger.info('Swap tracker is running! Press CTRL + C to stop it.');
};

runSwapTracker();
