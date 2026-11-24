// Recent signals and the in-memory Gold RWA quote snapshot for the API.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { logger } from './logger.js';
import type { GoldQuote } from './gold_rwa.js';
import type { WhaleSignal } from './notifier.js';
import { config } from './config.js';

const MAX_SIGNALS = 200;
const signals: WhaleSignal[] = [];
const dataDir = new URL('../data/', import.meta.url);
const signalFile = new URL('signal_state.json', dataDir);
const tempFile = new URL('signal_state.json.tmp', dataDir);
let persistSignals = false;

export const startedAt = new Date().toISOString();

export interface GoldSnapshot {
  attemptedAt: string | null;
  updatedAt: string | null;
  quotes: (GoldQuote & { updatedAt: string; stale: boolean })[];
}

let gold: GoldSnapshot = { attemptedAt: null, updatedAt: null, quotes: [] };

function isSavedSignal(value: unknown): value is WhaleSignal {
  const s = value as Partial<WhaleSignal> | null;
  return (s?.kind === 'whale_buy' || s?.kind === 'new_pool' || s?.kind === 'gold_rwa') &&
    (s.chain === 'base' || s.chain === 'ethereum') &&
    typeof s.createdAt === 'string' && Number.isFinite(Date.parse(s.createdAt)) &&
    typeof s.token?.address === 'string' && typeof s.token?.symbol === 'string' &&
    typeof s.links?.explorerToken === 'string';
}

export function initSignalHistory(): void {
  if (persistSignals) return;
  try {
    const saved: unknown = JSON.parse(readFileSync(signalFile, 'utf8'));
    if (!Array.isArray(saved) || !saved.every(isSavedSignal)) throw new Error('invalid signal history');
    signals.push(...saved.slice(0, MAX_SIGNALS - signals.length));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ code }, 'could not restore signal history; saving is disabled');
      return;
    }
  }
  persistSignals = true;
}

export function recordSignal(s: WhaleSignal): void {
  signals.unshift(s);
  if (signals.length > MAX_SIGNALS) signals.length = MAX_SIGNALS;
  if (!persistSignals) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tempFile, JSON.stringify(signals), { mode: 0o600 });
    renameSync(tempFile, signalFile);
  } catch (err) {
    logger.warn({ code: (err as NodeJS.ErrnoException).code }, 'could not save signal history');
  }
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
  const now = new Date(Date.now()).toISOString();
  const byAsset = new Map(gold.quotes.map((q) => [`${q.chain}:${q.symbol}`, { ...q, stale: true }]));
  for (const q of quotes) {
    byAsset.set(`${q.chain}:${q.symbol}`, { ...q, updatedAt: now, stale: false });
  }
  gold = {
    attemptedAt: now,
    updatedAt: quotes.length > 0 ? now : gold.updatedAt,
    quotes: [...byAsset.values()],
  };
}

export function getGoldSnapshot(): GoldSnapshot {
  const now = Date.now();
  return {
    ...gold,
    quotes: gold.quotes.map((q) => {
      const ageMs = now - Date.parse(q.updatedAt);
      return { ...q, stale: q.stale || ageMs < 0 || ageMs > config.gold.pollMs * 3 };
    }),
  };
}
