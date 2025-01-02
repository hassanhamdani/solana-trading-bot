import mongoose from 'mongoose';

// Define the interface for a trade
export interface ITrade {
  tokenIn: {
    mint: string;
    amount: number;
    symbol?: string;
    decimals?: number;
  };
  tokenOut: {
    mint: string;
    amount: number;
    symbol?: string;
    decimals?: number;
  };
  signature?: string;
  timestamp: Date;
  targetWallet: string;
  userWallet: string;
  type: 'BUY' | 'SELL';
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  priceImpact?: number;
  computeUnits?: number;
  slippage?: number;
}

// Create the mongoose schema
const TradeSchema = new mongoose.Schema<ITrade>({
  tokenIn: {
    mint: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    symbol: String,
    decimals: Number
  },
  tokenOut: {
    mint: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    symbol: String,
    decimals: Number
  },
  signature: { type: String, required: false, unique: true, sparse: true },
  timestamp: { type: Date, default: Date.now, index: true },
  targetWallet: { type: String, required: true, index: true },
  userWallet: { type: String, required: true, index: true },
  type: { type: String, enum: ['BUY', 'SELL'], required: true },
  status: { type: String, enum: ['SUCCESS', 'FAILED', 'PENDING'], required: true },
  priceImpact: Number,
  computeUnits: Number,
  slippage: Number
});

// Create and export the model
export const Trade = mongoose.model<ITrade>('Trade', TradeSchema);