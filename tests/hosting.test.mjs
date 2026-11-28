import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/read.js';

const originalFetch = globalThis.fetch;
const envKeys = ['ENGINE_API_ORIGIN', 'API_TOKEN', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
async function request(url, method = 'GET', authorization, query) {
  const result = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ url, method, headers: { authorization }, query }, result);
  return result;
}
test('unset and unreachable origins fail explicitly without inventing engine responses', async () => {
  delete process.env.ENGINE_API_ORIGIN;
  delete process.env.SUPABASE_URL;
  assert.equal((await request('/api/engine/snapshot')).code, 503);
  process.env.ENGINE_API_ORIGIN = 'https://engine.example';
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await request('/api/engine/snapshot')).code, 502);
});
test('Vercel rewrites preserve the engine path and user query without leaking the routing parameter', async () => {
  delete process.env.ENGINE_API_ORIGIN;
  delete process.env.SUPABASE_URL;
  assert.equal((await request('/api/read?__deck_path=engine/snapshot')).code, 503);
  assert.equal((await request('/api/read?__deck_path=engine/kill')).code, 404);
  process.env.ENGINE_API_ORIGIN = 'https://engine.example';
  let seen;
  globalThis.fetch = async (url) => { seen = url; return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  const result = await request('/api/read?symbol=ETHUSDT&limit=30', 'GET', undefined, { __deck_path: 'engine/candles' });
  assert.equal(result.code, 200);
  assert.equal(seen.toString(), 'https://engine.example/api/engine/candles?symbol=ETHUSDT&limit=30');
});
test('proxy preserves client authorization and engine auth failures without redirecting credentials', async () => {
  process.env.ENGINE_API_ORIGIN = 'https://engine.example';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://engine.example/api/engine/candles?symbol=BTCUSD');
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  };
  const res = await request('/api/engine/candles?symbol=BTCUSD', 'GET', 'Bearer test-token');
  assert.equal(res.code, 401);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('proxy restricts paths, methods, mutation auth and malformed upstream responses', async () => {
  process.env.ENGINE_API_ORIGIN = 'http://engine.example';
  assert.equal((await request('/api/engine/snapshot')).code, 503);
  assert.equal((await request('/api/private')).code, 404);
  assert.equal((await request('/api/engine/snapshot', 'POST')).code, 405);
  assert.equal((await request('/api/engine/kill', 'POST', 'Bearer test-token')).code, 404);
  process.env.ENGINE_API_ORIGIN = 'https://engine.example';
  globalThis.fetch = async () => new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } });
  assert.equal((await request('/api/engine/snapshot')).code, 502);
});

test('non-JSON gateway authentication failures keep their original status', async () => {
  process.env.ENGINE_API_ORIGIN = 'https://engine.example';
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response('<html>access denied</html>', { status, headers: { 'content-type': 'text/html' } });
    assert.equal((await request('/api/engine/snapshot')).code, status);
  }
});

test('the rewritten Vercel route can serve hosted paper data without an upstream origin', async () => {
  delete process.env.ENGINE_API_ORIGIN;
  Object.assign(process.env, {
    API_TOKEN: 'deck-test', SUPABASE_URL: 'https://storage.example', SUPABASE_SECRET_KEY: 'secret-test',
  });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (String(url).startsWith('https://api.binance.com/')) {
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      return Response.json([[now, '2500', '2501', '2499', '2500', '1', 0, '0', 0, '0', '0', '0']]);
    }
    assert.equal(String(url), 'https://storage.example/rest/v1/rpc/paper_engine_read');
    assert.deepEqual(JSON.parse(options.body), { p_key: 'decisions', p_symbol: null });
    return Response.json([]);
  };
  const url = '/api/read?__deck_path=engine/candles&symbol=ethusdt';
  assert.equal((await request(url)).code, 401);
  const result = await request(url, 'GET', 'Bearer deck-test');
  assert.equal(result.code, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.data.symbol, 'ETHUSDT');
  assert.equal(result.data.source, 'binance');
  assert.equal(result.data.candles.length, 1);
  assert.equal(result.data.candles[0].c, 2500);
  assert.deepEqual((await request('/api/read?__deck_path=whales', 'GET', 'Bearer deck-test')).data,
    { count: 0, signals: [], available: false });
  assert.equal(calls, 1);
});

test('hosted deck uses restrictive security headers without external script access', async () => {
  const { readFile } = await import('node:fs/promises');
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const headers = Object.fromEntries(vercel.headers.flatMap((group) => group.headers.map((h) => [h.key.toLowerCase(), h.value])));
  assert.match(headers['content-security-policy'], /default-src 'none'/);
  assert.match(headers['content-security-policy'], /script-src 'self'/);
  assert.match(headers['content-security-policy'], /connect-src 'self'/);
  assert.doesNotMatch(headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
});
