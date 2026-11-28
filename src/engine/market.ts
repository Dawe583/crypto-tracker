// Public CEX market data with exchange fallback. No API keys.
import { logger } from '../logger.js';
import type { Candle } from './types.js';

const CANDLE_LIMIT = 300;
export const DEFAULT_CLOSED_BARS = 30;
const REQUEST_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_MS = 5_000;
const CANDLE_UNIT_MS: Record<string, number> = {
  s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 31 * 86_400_000,
};
const BYBIT_INTERVALS: Record<string, string | undefined> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120',
  '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M',
};
const COINBASE_INTERVALS: Record<string, string | undefined> = {
  '1m': '60', '5m': '300', '15m': '900', '1h': '3600', '6h': '21600', '1d': '86400',
};
const KRAKEN_INTERVALS: Record<string, string | undefined> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240',
  '1d': '1440', '1w': '10080', '15d': '21600',
};

export interface Feed { candles: Candle[]; price: number; source: 'binance' | 'bybit' | 'coinbase' | 'kraken'; lastFetch: number; requestedAt?: number }
const feeds = new Map<string, Feed>();

const fetchMarket = (url: string) => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

async function fromBinance(symbol: string, interval: string): Promise<Candle[]> {
  const r = await fetchMarket(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}`);
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const j: any[] = await r.json();
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

async function fromBybit(symbol: string, interval: string): Promise<Candle[]> {
  const r = await fetchMarket(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}`);
  if (!r.ok) throw new Error(`bybit ${r.status}`);
  const j: any = await r.json();
  if (j.retCode !== 0) throw new Error(`bybit ${j.retMsg}`);
  return (j.result.list as any[]).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
}

// Coinbase Exchange public candles: BTCUSDT -> BTC-USD. US-friendly fallback.
async function fromCoinbase(symbol: string, gran: string): Promise<Candle[]> {
  const base = symbol.replace(/USDT$|USD$/, '');
  const product = `${base}-USD`;
  const end = new Date();
  const start = new Date(end.getTime() - CANDLE_LIMIT * Number(gran) * 1000);
  const r = await fetchMarket(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}&start=${start.toISOString()}&end=${end.toISOString()}`);
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const j: any[] = await r.json();
  if (!Array.isArray(j)) throw new Error('coinbase bad payload');
  return j.map((k) => ({ t: k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5] })).sort((a, b) => a.t - b.t);
}

const KRAKEN_PAIR: Record<string, string> = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'DOGEUSD', ADA: 'ADAUSD', AVAX: 'AVAXUSD', LINK: 'LINKUSD', DOT: 'DOTUSD', MATIC: 'MATICUSD' };
async function fromKraken(symbol: string, interval: string): Promise<Candle[]> {
  const base = symbol.replace(/USDT$|USD$/, '');
  const pair = KRAKEN_PAIR[base] ?? `${base}USD`;
  const r = await fetchMarket(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`);
  if (!r.ok) throw new Error(`kraken ${r.status}`);
  const j: any = await r.json();
  if (j.error?.length) throw new Error(`kraken ${j.error[0]}`);
  const rows = Object.values(j.result)[0] as any[];
  return rows.map((k) => ({ t: +k[0] * 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
}

const sources = [
  ['binance', fromBinance],
  ['bybit', fromBybit, BYBIT_INTERVALS],
  ['coinbase', fromCoinbase, COINBASE_INTERVALS],
  ['kraken', fromKraken, KRAKEN_INTERVALS],
] as const;

export function intervalMs(interval: string) {
  const [, count, unit] = /^(\d+)([smhdwM])$/.exec(interval) ?? [];
  return Number(count) * CANDLE_UNIT_MS[unit];
}

export function completedCandles(feed: Feed, interval: string) {
  const ms = intervalMs(interval);
  return feed.candles.filter((c) => c.t + ms <= (feed.requestedAt ?? feed.lastFetch));
}

export function closedStrategyBars(feed: Feed, interval: string, count: number): Candle[] {
  const ms = intervalMs(interval);
  if (!Number.isSafeInteger(ms) || ms <= 0 || interval.endsWith('M')) return [];
  const bars = completedCandles(feed, interval).slice(-count);
  if (bars.length !== count || (feed.requestedAt ?? feed.lastFetch) - bars[bars.length - 1].t >= 2 * ms) return [];
  return bars.every((c, i) => i === 0 || c.t - bars[i - 1].t === ms) ? bars : [];
}

export function validClosedBars(feed: Feed, interval: string, minCount = DEFAULT_CLOSED_BARS): Candle[] {
  const completed = completedCandles(feed, interval).slice(-CANDLE_LIMIT);
  if (completed.length < minCount) return [];
  return closedStrategyBars({ ...feed, candles: completed }, interval, completed.length);
}

export async function fetchSymbol(symbol: string, interval: string, { requireRecent = true, closedBars = 0 } = {}): Promise<Feed | null> {
  const maxAgeMs = 2 * intervalMs(interval);
  if (requireRecent && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)) {
    logger.warn({ interval }, 'invalid paper market interval');
    return null;
  }
  let markOnly: Feed | null = null;
  for (const [source, fn, intervals] of sources) {
    const exchangeInterval = intervals ? intervals[interval] : interval;
    if (!exchangeInterval) continue;
    try {
      const requestedAt = Date.now();
      const candles = await fn(symbol, exchangeInterval);
      if (!candles.length || candles.some(({ t, o, h, l, c, v }) =>
        !Number.isFinite(t) || ![o, h, l, c].every((p) => Number.isFinite(p) && p > 0)
        || h < l || h < Math.max(o, c) || l > Math.min(o, c)
        || !Number.isFinite(v) || v < 0)) throw new Error('invalid market candles');
      const latest = candles[candles.length - 1];
      const lastFetch = Date.now();
      const age = lastFetch - latest.t;
      if (requireRecent && (age > maxAgeMs || age < -CLOCK_SKEW_MS)) throw new Error('market candle timestamp out of range');
      const feed = { candles, price: latest.c, source, lastFetch, requestedAt };
      if (!closedBars || interval.endsWith('M') || validClosedBars(feed, interval, closedBars).length) return feed;
      markOnly ??= feed;
    } catch (err) {
      logger.warn({ err: String(err), symbol, source }, 'market feed failed');
    }
  }
  return markOnly;
}

export async function refreshSymbol(symbol: string, interval: string, { requireRecent = false, closedBars = 0 } = {}): Promise<Feed | null> {
  const feed = await fetchSymbol(symbol, interval, { requireRecent, closedBars });
  if (feed) feeds.set(symbol, feed);
  return feed;
}

export const getFeed = (symbol: string) => feeds.get(symbol) ?? null;
