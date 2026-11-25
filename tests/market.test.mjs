import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/market.js';
import { logger } from '../src/logger.js';

logger.level = 'silent';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
async function request(method = 'GET') {
  const response = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method }, response);
  return response;
}
const time = Math.floor(Date.now() / 60_000) * 60_000;
const rows = [[time - 60_000, '100', '102', '99', '101', '20'], [time, '101', '103', '100', '102', '22']];

test('public markets reuse validated exchange feeds without auth or storage', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json(rows); };
  const result = await request();
  assert.equal(result.code, 200);
  assert.equal(Object.keys(result.body.markets).length, 6);
  assert.ok(urls.every((url) => url.startsWith('https://api.binance.com/api/v3/klines?')));
  const btc = result.body.markets.BTCUSDT;
  assert.equal(btc.price, 102);
  assert.equal(btc.quote, 'USDT');
  assert.equal(btc.source, 'binance');
  assert.equal(btc.candles.at(-1).t, time);
  assert.ok(btc.lastFetch >= time);
  assert.match(result.headers['Cache-Control'], /s-maxage=20/);
});

test('regional exchange failures fall back to honestly denominated USD candles', async () => {
  globalThis.fetch = async (url) => String(url).includes('api.exchange.coinbase.com')
    ? Response.json([[time / 1000, 100, 103, 101, 102, 22], [(time - 60_000) / 1000, 99, 102, 100, 101, 20]])
    : new Response('', { status: 451 });
  const result = await request();
  assert.equal(result.code, 200);
  assert.equal(result.body.markets.BTCUSDT.source, 'coinbase');
  assert.equal(result.body.markets.BTCUSDT.quote, 'USD');
  assert.equal(result.body.markets.BTCUSDT.price, 102);
});

test('outages and malformed/stale feeds fail explicitly, and writes never fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json([[0, 'bad', 1, 1, 1, 1]]); };
  const result = await request();
  assert.equal(result.code, 503);
  assert.equal(result.body.markets, undefined);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  calls = 0;
  assert.equal((await request('POST')).code, 405);
  assert.equal(calls, 0);
});
