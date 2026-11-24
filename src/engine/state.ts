// In-memory engine snapshot served by the API and the trading deck.
import type { DecisionRecord, Position } from './types.js';

export interface EngineSnapshot {
  equityUsd: number;
  cashUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  positions: Array<Position & { markPrice: number; unrealizedUsd: number }>;
  stats: Record<string, { pnl: number; trades: number; wins: number }>;
  equityCurve: { ts: number; equityUsd: number }[];
  killed: boolean;
  prices: Record<string, number>;
  cycleAt: string;
}

export const engineState: { snapshot: EngineSnapshot | null; decisions: DecisionRecord[]; halted: boolean } = {
  snapshot: null,
  decisions: [],
  halted: false,
};
