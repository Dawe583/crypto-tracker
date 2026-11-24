import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSymbol } from '../src/engine/market.js';

test('market data skips stale and future candles and accepts a recent fallback', async (t) => {
  const now = Date.now();
  const old = now - 10 * 60_000;
  const recent = Math.floor(now / 60_000) * 60 - 60;
  let fallbackAt = recent;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('binance')) return Response.json([[old, 99, 99, 99, 99, 1]]);
    if (url.includes('bybit')) return Response.json({
      retCode: 0, result: { list: [[now + 60_000, 98, 98, 98, 98, 1]] },
    });
    if (url.includes('coinbase')) return Response.json([[fallbackAt, 100, 100, 100, 100, 1]]);
    return new Response(null, { status: 503 });
  });
  const feed = await fetchSymbol('BTCUSDT', '1m');
  assert.equal(feed?.source, 'coinbase');
  assert.equal(feed?.price, 100);
  fallbackAt = Math.floor(old / 1000);
  assert.equal(await fetchSymbol('BTCUSDT', '1m'), null);
});
