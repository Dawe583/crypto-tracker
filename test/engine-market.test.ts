import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { getFeed, refreshSymbol } from '../src/engine/market.js';

test('falls back after a request timeout or invalid quote, without returning cached data on failure', async (t) => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 5_000);
    return timeout(5);
  });
  const attempted: string[] = [];
  let outage = false;
  let timedOut = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const host = new URL(url).hostname;
    attempted.push(host);
    if (outage) return new Response(null, { status: 503 });
    if (host === 'api.binance.com') {
      await setTimeout(250, undefined, { signal: init?.signal }).catch((err) => {
        timedOut = err.cause?.name === 'TimeoutError';
        throw err;
      });
      assert.fail('Binance request did not time out');
    }
    if (host === 'api.bybit.com') {
      return Response.json({ retCode: 0, result: { list: [[1_000, 100, 102, 99, 'bad', 10]] } });
    }
    return Response.json([[1, 99, 102, 100, 101, 10]]);
  });

  const fresh = await refreshSymbol('BTCUSDT', '1m');
  assert.equal(fresh?.source, 'coinbase');
  assert.equal(fresh?.price, 101);
  assert.equal(timedOut, true);
  assert.deepEqual(attempted, ['api.binance.com', 'api.bybit.com', 'api.exchange.coinbase.com']);

  outbreak: {
    outage = true;
    assert.equal(await refreshSymbol('BTCUSDT', '1m'), null);
    assert.equal(getFeed('BTCUSDT'), fresh);
  }
});

test('live market refresh skips old candles and leaves historical callers unchanged', async (t) => {
  const now = Date.UTC(2026, 10, 24, 23, 58);
  t.mock.method(Date, 'now', () => now);
  let bybitTime = now - 60_000;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const host = new URL(url).hostname;
    if (host === 'api.binance.com') return Response.json([[now - 180_000, 100, 102, 99, 101, 10]]);
    if (host === 'api.bybit.com') return Response.json({ retCode: 0, result: { list: [[bybitTime, 100, 103, 99, 102, 10]] } });
    return new Response(null, { status: 503 });
  });

  const live = { requireRecent: true };
  assert.equal((await refreshSymbol('ETHUSDT', '1m', live))?.source, 'bybit');
  bybitTime = now + 60_000;
  assert.equal(await refreshSymbol('ETHUSDT', '1m', live), null);
  assert.equal(getFeed('ETHUSDT')?.source, 'bybit');
  assert.equal((await refreshSymbol('ETHUSDT', '5m', live))?.source, 'binance');
  assert.equal((await refreshSymbol('ETHUSDT', '1m'))?.source, 'binance');
});

test('fallback requests the configured 30-minute candles and skips unsupported exchanges', async (t) => {
  const now = Date.UTC(2026, 10, 24, 23, 10);
  const open = now - 40 * 60_000;
  t.mock.method(Date, 'now', () => now);
  const requests: [string, string | null][] = [];
  let bybitAvailable = true;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const { hostname, searchParams } = new URL(url);
    requests.push([hostname, searchParams.get('interval') ?? searchParams.get('granularity')]);
    if (hostname === 'api.bybit.com' && bybitAvailable && searchParams.get('interval') === '30') {
      return Response.json({ retCode: 0, result: { list: [[open, 100, 103, 99, 102, 10]] } });
    }
    if (hostname === 'api.kraken.com' && searchParams.get('interval') === '30') {
      return Response.json({ error: [], result: { XBTUSD: [[open / 1000, 100, 103, 99, 102, 101, 10]] } });
    }
    return new Response(null, { status: 503 });
  });

  const live = { requireRecent: true };
  assert.equal((await refreshSymbol('BTCUSDT', '30m', live))?.source, 'bybit');
  bybitAvailable = false;
  assert.equal((await refreshSymbol('BTCUSDT', '30m', live))?.source, 'kraken');
  assert.deepEqual(requests, [
    ['api.binance.com', '30m'], ['api.bybit.com', '30'],
    ['api.binance.com', '30m'], ['api.bybit.com', '30'], ['api.kraken.com', '30'],
  ]);
});
