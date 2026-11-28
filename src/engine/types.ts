// Shared types for the trading engine: candles, intents, positions, ledger records.
export interface Candle {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = 'buy' | 'sell';

// A narrow typed call, produced by a strategy (or later by a decision model).
// Everything downstream — sizing, risk, fill — is code.
export interface TradeIntent {
  strategy: string;
  symbol: string;
  side: Side;
  confidence: number; // 0..1
  reason: string;
  sizeUsd?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  maxHoldMin?: number;
  management?: { riskPct: number; trailAfterPct: number };
}

export interface Position {
  id: string;
  strategy: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTs: number;
  sizeUsd: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  maxHoldMin: number | null;
  entryFeeUsd?: number;
  trailing?: { afterPct: number; peak: number };
}

export interface Fill {
  id: string;
  strategy: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  usd: number;
  feeUsd: number;
  reason: string;
  ts: number;
  pnlUsd?: number; // set on closes
}

export interface DecisionRecord {
  strategy: string;
  symbol: string;
  action: Side | 'hold';
  confidence: number;
  reason: string;
  vetoed?: string; // risk veto reason, if rejected
  ts: number;
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
  cashUsd: number;
  openPositions: number;
  dayPnlUsd: number;
}

export interface StrategyContext {
  symbol: string;
  candles: Candle[]; // oldest → newest
  price: number;
  positions: Position[]; // all open positions (any strategy)
  signals: { whaleBuys: number; newPools: number; goldSpread: Record<string, number>; whaleSymbols?: Record<string, number> };
  params: Record<string, number>;
}

export interface Strategy {
  name: string;
  description: string;
  defaults: Record<string, number>;
  closedBars?: number;
  evaluate(ctx: StrategyContext): TradeIntent[];
}
