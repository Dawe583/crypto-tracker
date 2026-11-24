import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedCandles, fetchSymbol } from '../src/engine/market.js';

test('a request crossing the candle boundary does not finalize its pre-close snapshot', async (t) => {
  const minute = 60_000;
  const open = Date.UTC(2026, 10, 24, 12);
  let now = open + minute - 1;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    now = open + minute + 1;
    return Response.json([[open - minute, 99, 99, 99, 99, 1], [open, 100, 101, 99, 101, 1]]);
  });
  const crossing = await fetchSymbol('BTCUSDT', '1m');
  assert.ok(crossing);
  assert.deepEqual(completedCandles(crossing, '1m').map((c) => c.t), [open - minute]);
  const after = await fetchSymbol('BTCUSDT', '1m');
  assert.ok(after);
  assert.deepEqual(completedCandles(after, '1m').map((c) => c.t), [open - minute, open]);
});

test('market data skips stale and future candles and accepts a recent fallback', async (t) => {
  const now = Date.now();
  const old = now - 10 * 60_000;
  const recent = Math.floor((now - 60_000) / 1000);
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
