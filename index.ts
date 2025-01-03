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
        // Test both HTTP and WebSocket connections
        const [blockHash, slot] = await Promise.all([
            connection.getLatestBlockhash(),
            connection.getSlot()
        ]);
        
        logger.info('RPC connections established successfully');
        logger.info(`Current slot: ${slot}`);
        
        // Monitor WebSocket health
        connection.onSlotChange(() => {/* Keep connection alive */});
        
    } catch (error) {
        logger.error('Failed to connect to RPC:', error);
        process.exit(1);
    }
};

// Add this constant at the top with other constants
const MIN_SOL_BALANCE = 0.5;

const runSwapTracker = async () => {
    await checkConnection();
    logger.level = LOG_LEVEL;
    logger.info('Swap tracker is starting...');

    const walletToTrack = '5iywveQKkidqPDKt2CExJcWKex2EXz9kbGcYiZvhuXWs';
    logger.info(`Starting to track wallet: ${walletToTrack}`);

    const privateKey = process.env.PRIVATE_KEY || '';
    const bot = new Bot(connection, walletToTrack, privateKey);
    
    // Add balance check interval
    const balanceCheckInterval = setInterval(async () => {
        try {
            const balance = await connection.getBalance(bot.userWallet.publicKey);
            const solBalance = balance / 1e9; // Convert lamports to SOL
            
            if (solBalance < MIN_SOL_BALANCE) {
                logger.warn(`SOL balance (${solBalance}) below minimum threshold of ${MIN_SOL_BALANCE}. Stopping bot...`);
                clearInterval(balanceCheckInterval);
                await bot.stop();
                process.exit(0);
            }
        } catch (error) {
            logger.error('Error checking balance:', error);
        }
    }, 30000); // Check every 30 seconds

    await bot.start();
    logger.info('Swap tracker is running! Press CTRL + C to stop it.');
};

runSwapTracker();
