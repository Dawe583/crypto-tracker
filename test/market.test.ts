import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedStrategyBars, completedCandles, fetchSymbol, validClosedBars } from '../src/engine/market.js';

test('a request crossing the candle boundary uses its pre-close window without falling back', async (t) => {
  const minute = 60_000;
  const open = Date.UTC(2026, 10, 24, 12);
  let now = open + minute - 1;
  t.mock.method(Date, 'now', () => now);
  const marketRequest = t.mock.method(globalThis, 'fetch', async () => {
    now = open + minute + 1;
    return Response.json([[open - minute, 99, 99, 99, 99, 1], [open, 100, 101, 99, 101, 1]]);
  });
  const crossing = await fetchSymbol('BTCUSDT', '1m', { closedBars: 1 });
  assert.ok(crossing);
  assert.equal(marketRequest.mock.callCount(), 1);
  assert.deepEqual(completedCandles(crossing, '1m').map((c) => c.t), [open - minute]);
  assert.deepEqual(closedStrategyBars(crossing, '1m', 1).map((c) => c.t), [open - minute]);
  const after = await fetchSymbol('BTCUSDT', '1m', { closedBars: 1 });
  assert.ok(after);
  assert.deepEqual(completedCandles(after, '1m').map((c) => c.t), [open - minute, open]);
  assert.deepEqual(closedStrategyBars(after, '1m', 1).map((c) => c.t), [open]);
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


test('market data rejects impossible candle ranges before using them', async (t) => {
  const now = Date.UTC(2026, 10, 24, 12);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('binance')) return Response.json([[now - 60_000, 100, 99, 98, 100, 1]]);
    if (url.includes('bybit')) return Response.json({ retCode: 0, result: { list: [[now - 60_000, 100, 101, 99, 100, 1]] } });
    return new Response(null, { status: 503 });
  });
  const feed = await fetchSymbol('BTCUSDT', '1m');
  assert.equal(feed?.source, 'bybit');
});

test('prefers a contiguous fallback for signals but keeps the first mark for exits', async (t) => {
  const minute = 60_000;
  const current = Date.UTC(2026, 10, 24, 12);
  t.mock.method(Date, 'now', () => current + 1_000);
  const candle = (barsAgo: number) => [current - barsAgo * minute, 100, 100, 100, 100, 1];
  let complete = true;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('binance')) return Response.json([candle(3), candle(1), candle(0)]);
    if (url.includes('bybit') && complete)
      return Response.json({ retCode: 0, result: { list: [candle(0), candle(1), candle(2)] } });
    return new Response(null, { status: 503 });
  });
  const valid = await fetchSymbol('BTCUSDT', '1m', { closedBars: 2 });
  assert.equal(valid?.source, 'bybit');
  assert.equal(closedStrategyBars(valid!, '1m', 2).length, 2);
  complete = false;
  const markOnly = await fetchSymbol('BTCUSDT', '1m', { closedBars: 2 });
  assert.equal(markOnly?.source, 'binance');
  assert.equal(markOnly.price, 100);
  assert.deepEqual(closedStrategyBars(markOnly, '1m', 2), []);
});


test('closed signal validation is bounded to the latest exchange window', () => {
  const minute = 60_000;
  const current = Date.UTC(2026, 10, 24, 12);
  const candle = (index: number) => ({ t: current - (302 - index) * minute, o: 100, h: 101, l: 99, c: 100, v: 1 });
  const completed = Array.from({ length: 303 }, (_, i) => candle(i)).filter((_, i) => i !== 1);
  const feed = { candles: completed, price: 100, source: 'kraken' as const, lastFetch: current + 1_000, requestedAt: current + 1_000 };
  assert.equal(validClosedBars(feed, '1m', 30).length, 300);
  const recentGap = { ...feed, candles: Array.from({ length: 303 }, (_, i) => candle(i)).filter((_, i) => i !== 300) };
  assert.deepEqual(validClosedBars(recentGap, '1m', 30), []);
});
