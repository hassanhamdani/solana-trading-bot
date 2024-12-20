import { Connection } from '@solana/web3.js';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor } from './transactions';
import { MarketCache, PoolCache } from './cache';
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
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  BUY_SLIPPAGE,
} from './helpers';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TokenAmount } from '@raydium-io/raydium-sdk';
import { WalletCopier } from './wallet-copier';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

const runCopyTrader = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Copy trader is starting...');

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  const txExecutor = new DefaultTransactionExecutor(connection);

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  
  // Minimal configuration for copy trading only
  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    maxBuyRetries: MAX_BUY_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    buySlippage: BUY_SLIPPAGE,
    // Disable all filters and checks
    filterCheckInterval: 0,
    filterCheckDuration: 0,
    consecutiveMatchCount: 1
  };

  const bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig);

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
