export const swapConfig = {
  executeSwap: true,
  useVersionedTransaction: true,
  maxLamports: 1000000,
  maxRetries: 10,
  liquidityFile: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
  slippageTolerance: 10,
  minSolAmount: 0.00001,
  maxGasMultiplier: 1.5
}; 