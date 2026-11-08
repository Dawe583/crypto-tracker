// In-memory store for the API: recent signals (whale buys, new pools, gold alerts) and the latest Gold RWA snapshot.
// Data resets on restart. Signals are kept in a bounded ring buffer.
import type { GoldQuote } from './gold_rwa.js';
import type { WhaleSignal } from './notifier.js';

const MAX_SIGNALS = 200;
const signals: WhaleSignal[] = [];

export const startedAt = new Date().toISOString();

export interface GoldSnapshot {
  attemptedAt: string | null;
  updatedAt: string | null;
  quotes: GoldQuote[];
}

let gold: GoldSnapshot = { attemptedAt: null, updatedAt: null, quotes: [] };

export function recordSignal(s: WhaleSignal): void {
  signals.unshift(s);
  if (signals.length > MAX_SIGNALS) signals.length = MAX_SIGNALS;
}

export function listSignals(kind: WhaleSignal['kind'], limit: number): WhaleSignal[] {
  return signals.filter((s) => s.kind === kind).slice(0, limit);
}

export function countSignals(): Record<WhaleSignal['kind'], number> {
  const c = { whale_buy: 0, new_pool: 0, gold_rwa: 0 };
  for (const s of signals) c[s.kind] += 1;
  return c;
}

export function setGoldSnapshot(quotes: GoldQuote[]): void {
  const now = new Date().toISOString();
  gold = {
    attemptedAt: now,
    updatedAt: quotes.length > 0 ? now : gold.updatedAt,
    quotes: quotes.length > 0 ? quotes : gold.quotes,
  };
}

export function getGoldSnapshot(): GoldSnapshot {
  return gold;
}
