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
