import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchSymbol } from '../src/engine/market.js';

type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
};

// Public, read-only market data is independent of the paper engine and storage.
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'];
const CACHE_MS = 20_000;
type Markets = Record<string, unknown>;
let cached: { at: number; markets: Markets } | undefined;
let pending: Promise<Markets> | undefined;

async function loadMarkets(): Promise<Markets> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.markets;
  pending ??= (async () => {
    const entries = await Promise.all(symbols.map(async (symbol) => {
      const feed = await fetchSymbol(symbol, '1m');
      if (!feed) return null;
      const quote = ['coinbase', 'kraken'].includes(feed.source) ? 'USD' : 'USDT';
      return [symbol, { ...feed, candles: feed.candles.slice(-120), quote }] as const;
    }));
    const markets: Markets = {};
    for (const entry of entries) if (entry) markets[entry[0]] = entry[1];
    if (Object.keys(markets).length) cached = { at: Date.now(), markets };
    return markets;
  })().finally(() => { pending = undefined; });
  return pending;
}

export function resetMarketCacheForTests() {
  cached = undefined;
  pending = undefined;
}

export default async function handler(req: IncomingMessage, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const markets = await loadMarkets();
    if (!Object.keys(markets).length) return res.status(503).json({ error: 'Market data unavailable' });
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=10');
    return res.status(200).json({ markets });
  } catch {
    return res.status(503).json({ error: 'Market data unavailable' });
  }
}
