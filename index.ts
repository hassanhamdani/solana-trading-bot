import './server';
import { Connection } from '@solana/web3.js';
import { logger, COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, LOG_LEVEL } from './helpers';
import { SwapTracker } from './wallet-copier';
import { CopyTradingBot as Bot } from './bot';
import { connectToDatabase, disconnectFromDatabase } from './db/connection';
import dotenv from 'dotenv';

dotenv.config();

const connection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    commitment: COMMITMENT_LEVEL,
    confirmTransactionInitialTimeout: 60000,
    httpHeaders: {
        'Cache-Control': 'no-cache',
    },
});

// Add connection check
const checkConnections = async () => {
    try {
        // Check Solana RPC connection
        await connection.getLatestBlockhash();
        logger.info('✅ RPC connection established successfully');

        // Check MongoDB connection
        await connectToDatabase();
        logger.info('✅ Database connection established successfully');
    } catch (error) {
        logger.error('❌ Connection check failed:', error);
        process.exit(1);
    }
};

const runSwapTracker = async () => {
    await checkConnections();
    logger.level = LOG_LEVEL;
    logger.info('Swap tracker is starting...');

    const walletToTrack = '5iywveQKkidqPDKt2CExJcWKex2EXz9kbGcYiZvhuXWs';
    logger.info(`Starting to track wallet: ${walletToTrack}`);

    const privateKey = process.env.PRIVATE_KEY || '';
    const bot = new Bot(connection, walletToTrack, privateKey);

    await bot.start();
    logger.info('Swap tracker is running! Press CTRL + C to stop it.');
};

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT. Cleaning up...');
    await disconnectFromDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM. Cleaning up...');
    await disconnectFromDatabase();
    process.exit(0);
});

runSwapTracker();
