import { fetchSymbol } from '../src/engine/market.js';

// Public, read-only market data is independent of the paper engine and storage.
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'];
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const entries = await Promise.all(symbols.map(async (symbol) => {
      const feed = await fetchSymbol(symbol, '1m');
      if (!feed) return null;
      const quote = ['coinbase', 'kraken'].includes(feed.source) ? 'USD' : 'USDT';
      return [symbol, { ...feed, candles: feed.candles.slice(-120), quote }];
    }));
    const markets = Object.fromEntries(entries.filter(Boolean));
    if (!Object.keys(markets).length) return res.status(503).json({ error: 'Market data unavailable' });
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=10');
    return res.status(200).json({ markets });
  } catch {
    return res.status(503).json({ error: 'Market data unavailable' });
  }
}
