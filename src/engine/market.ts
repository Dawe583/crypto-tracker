// Public CEX market data: Binance primary, Bybit fallback. No API keys.
import { logger } from '../logger.js';
import type { Candle } from './types.js';

const CANDLE_LIMIT = 300;
const MINUTES_PER_UNIT: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080, M: 44640 };

export interface Feed { candles: Candle[]; price: number; source: 'binance' | 'bybit' | 'coinbase' | 'kraken'; lastFetch: number }
const feeds = new Map<string, Feed>();
const fetchMarket = (url: string) => fetch(url, { signal: AbortSignal.timeout(5000) });

async function fromBinance(symbol: string, interval: string): Promise<Candle[]> {
  const r = await fetchMarket(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}`);
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const j: any[] = await r.json();
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

async function fromBybit(symbol: string, interval: string): Promise<Candle[]> {
  const iv = interval === '1m' ? '1' : interval === '5m' ? '5' : interval === '15m' ? '15' : interval === '1h' ? '60' : '240';
  const r = await fetchMarket(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${CANDLE_LIMIT}`);
  if (!r.ok) throw new Error(`bybit ${r.status}`);
  const j: any = await r.json();
  if (j.retCode !== 0) throw new Error(`bybit ${j.retMsg}`);
  return (j.result.list as any[]).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
}

// Coinbase Exchange public candles: BTCUSDT -> BTC-USD. US-friendly fallback.
async function fromCoinbase(symbol: string, interval: string): Promise<Candle[]> {
  const gran = interval === '1m' ? 60 : interval === '5m' ? 300 : interval === '15m' ? 900 : interval === '1h' ? 3600 : 21600;
  const base = symbol.replace(/USDT$|USD$/, '');
  const product = `${base}-USD`;
  const end = new Date();
  const start = new Date(end.getTime() - CANDLE_LIMIT * gran * 1000);
  const r = await fetchMarket(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}&start=${start.toISOString()}&end=${end.toISOString()}`);
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const j: any[] = await r.json();
  if (!Array.isArray(j)) throw new Error('coinbase bad payload');
  return j.map((k) => ({ t: k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5] })).sort((a, b) => a.t - b.t);
}

const KRAKEN_PAIR: Record<string, string> = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'DOGEUSD', ADA: 'ADAUSD', AVAX: 'AVAXUSD', LINK: 'LINKUSD', DOT: 'DOTUSD', MATIC: 'MATICUSD' };
async function fromKraken(symbol: string, interval: string): Promise<Candle[]> {
  const iv = interval === '1m' ? 1 : interval === '5m' ? 5 : interval === '15m' ? 15 : interval === '1h' ? 60 : 240;
  const base = symbol.replace(/USDT$|USD$/, '');
  const pair = KRAKEN_PAIR[base] ?? `${base}USD`;
  const r = await fetchMarket(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${iv}`);
  if (!r.ok) throw new Error(`kraken ${r.status}`);
  const j: any = await r.json();
  if (j.error?.length) throw new Error(`kraken ${j.error[0]}`);
  const rows = Object.values(j.result)[0] as any[];
  return rows.map((k) => ({ t: +k[0] * 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
}

export async function fetchSymbol(symbol: string, interval: string): Promise<Feed | null> {
  const [, amount, unit] = /^(\d+)([mhdwM])$/.exec(interval) ?? [];
  const period = Number(amount) * MINUTES_PER_UNIT[unit] * 60_000;
  for (const [source, fn] of [['binance', fromBinance], ['bybit', fromBybit], ['coinbase', fromCoinbase], ['kraken', fromKraken]] as const) {
    try {
      const candles = await fn(symbol, interval);
      if (!candles.length || candles.some(({ t, o, h, l, c, v }) =>
        !Number.isFinite(t) || ![o, h, l, c].every((p) => Number.isFinite(p) && p > 0)
        || !Number.isFinite(v) || v < 0)) throw new Error('invalid market candles');
      const latest = candles[candles.length - 1];
      const now = Date.now();
      // Candle timestamps are bucket opens; some exchanges omit the ongoing bucket.
      if (latest.t > now || !(now - latest.t < 2 * period)) throw new Error('stale market candles');
      return { candles, price: latest.c, source, lastFetch: now };
    } catch (err) {
      logger.warn({ err: String(err), symbol, source }, 'market feed failed');
    }
  }
  return null;
}

export async function refreshSymbol(symbol: string, interval: string): Promise<Feed | null> {
  const feed = await fetchSymbol(symbol, interval);
  if (feed) feeds.set(symbol, feed);
  return feed;
}

export const getFeed = (symbol: string) => feeds.get(symbol) ?? null;
