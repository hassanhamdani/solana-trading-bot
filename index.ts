import { Connection } from '@solana/web3.js';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  LOG_LEVEL,
  QUOTE_MINT,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  BUY_SLIPPAGE,
} from './helpers';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TokenAmount } from '@raydium-io/raydium-sdk';
import { WalletCopier } from './wallet-copier';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
  confirmTransactionInitialTimeout: 60000,
  httpHeaders: {
    'Cache-Control': 'no-cache',
  },
});

const runCopyTrader = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Copy trader is starting...');

  const txExecutor = new DefaultTransactionExecutor(connection);
  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  
  const botConfig: BotConfig = {
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    maxBuyRetries: MAX_BUY_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    buySlippage: BUY_SLIPPAGE,
  };

  const bot = new Bot(connection, txExecutor, botConfig);

  // Validate wallet before starting
  if (!await bot.validate()) {
    logger.error('Wallet validation failed. Exiting...');
    process.exit(1);
  }

  logger.info('------- CONFIGURATION -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);
  logger.info(`Quote Token: ${quoteToken.symbol}`);
  logger.info(`Buy amount: ${botConfig.quoteAmount.toFixed()}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);
  logger.info('----------------------------');

  const walletToTrack = '5iywveQKkidqPDKt2CExJcWKex2EXz9kbGcYiZvhuXWs';
  logger.info(`Starting to track wallet: ${walletToTrack}`);

  const copier = new WalletCopier(connection, bot, walletToTrack);
  await copier.trackTrades();

  logger.info('Copy trader is running! Press CTRL + C to stop it.');
};

runCopyTrader();
