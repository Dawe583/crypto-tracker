import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createHostedStore, hostedEngineEnabled, hostedStrategies, runHostedCycle } from './hosted.js';
import { fetchSymbol, type Feed } from './market.js';
import type { EngineSnapshot } from './state.js';

const reply = (status: number, body: unknown) => ({ status, body });
const failure = (status: number, error: string) => reply(status, { error });
const authorized = (given: string | undefined, secret: string | undefined) => {
  if (!given || !secret) return false;
  const value = Buffer.from(given);
  const expected = Buffer.from(`Bearer ${secret}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
};


const HOSTED_CANDLE_WINDOW = 120;
const HOSTED_CANDLE_CACHE_MS = 20_000;
const candleCache = new Map<string, { at: number; feed: Feed | null }>();
const pendingCandles = new Map<string, Promise<Feed | null>>();

async function hostedCandles(symbol: string): Promise<Feed | null> {
  const cached = candleCache.get(symbol);
  if (cached && Date.now() - cached.at < HOSTED_CANDLE_CACHE_MS) return cached.feed;
  let pending = pendingCandles.get(symbol);
  if (!pending) {
    pending = fetchSymbol(symbol, '1m').then((feed) => {
      const prior = candleCache.get(symbol)?.feed ?? null;
      const trimmed = feed ? { ...feed, candles: feed.candles.slice(-HOSTED_CANDLE_WINDOW) } : null;
      if (trimmed || !prior) candleCache.set(symbol, { at: Date.now(), feed: trimmed });
      return trimmed ?? prior;
    }).finally(() => pendingCandles.delete(symbol));
    pendingCandles.set(symbol, pending);
  }
  return pending;
}

export function resetHostedCandleCacheForTests() {
  candleCache.clear();
  pendingCandles.clear();
}

export const hostedReadPaths = new Set([
  '/api/engine/snapshot', '/api/engine/strategies', '/api/engine/decisions',
  '/api/engine/candles', '/api/whales', '/api/pools', '/api/gold',
]);

export async function hostedRead(url: URL, method?: string, authorization?: string) {
  if (!hostedReadPaths.has(url.pathname)) return failure(404, 'Not found');
  if (method !== 'GET') return failure(405, 'Method not allowed');
  if (!process.env.API_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return failure(503, 'No hosted engine is configured');
  }
  if (!authorized(authorization, process.env.API_TOKEN)) return failure(401, 'Engine access denied');
  try {
    const store = createHostedStore()!;
    switch (url.pathname) {
      case '/api/engine/snapshot': {
        const snapshot = await store.read('snapshot') as EngineSnapshot | null;
        if (!snapshot) return failure(503, 'Waiting for the first paper cycle');
        const cycleAt = Date.parse(snapshot.cycleAt);
        if (!Number.isFinite(cycleAt) || Date.now() - cycleAt > 300_000) {
          return failure(503, 'Last paper cycle is stale');
        }
        return reply(200, { ...snapshot, halted: false });
      }
      case '/api/engine/strategies':
        return reply(200, hostedStrategies().map(({ strategy, params, enabled }) =>
          ({ name: strategy.name, description: strategy.description, params, enabled })));
      case '/api/engine/decisions': {
        const n = Number(url.searchParams.get('limit') ?? 50);
        const limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 200) : 50;
        const decisions = await store.read('decisions');
        return reply(200, Array.isArray(decisions) ? decisions.slice(0, limit) : []);
      }
      case '/api/engine/candles': {
        const symbol = (url.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
        if (!/^[A-Z0-9]{1,20}$/.test(symbol) || !config.engine.symbols.includes(symbol)) return failure(400, 'Invalid symbol');
        const feed = await hostedCandles(symbol);
        return reply(200, feed ? { symbol, source: feed.source, lastFetch: feed.lastFetch, candles: feed.candles } : { symbol, candles: [] });
      }
      case '/api/gold':
        return reply(200, { assets: [], available: false });
      default:
        return reply(200, { count: 0, signals: [], available: false });
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'hosted paper read failed');
    return failure(503, 'Paper engine data unavailable');
  }
}

export async function hostedCron(method?: string, authorization?: string) {
  if (method !== 'POST') return failure(405, 'Method not allowed');
  if (!authorized(authorization, process.env.CRON_SECRET)) return failure(401, 'Cron access denied');
  if (process.env.CRON_SECRET === process.env.API_TOKEN) return failure(503, 'Cron requires a separate secret');
  if (!hostedEngineEnabled()) return failure(503, 'Production paper cron is disabled');
  try {
    const store = createHostedStore();
    if (!store) return failure(503, 'No hosted engine is configured');
    return reply(200, { committed: await runHostedCycle(store) });
  } catch (err) {
    logger.error({ err: String(err) }, 'hosted paper cycle failed');
    return failure(503, 'Paper cycle unavailable');
  }
}
