import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/[...path].js';

const originalFetch = globalThis.fetch;
const originalOrigin = process.env.ENGINE_API_ORIGIN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.ENGINE_API_ORIGIN;
  else process.env.ENGINE_API_ORIGIN = originalOrigin;
});
async function request(url, method = 'GET', authorization) {
  const result = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ url, method, headers: { authorization } }, result);
  return result;
}
test('unset and unreachable origins fail explicitly without inventing engine responses', async () => {
  delete process.env.ENGINE_API_ORIGIN;
  assert.equal((await request('/api/engine/snapshot')).code, 503);
  process.env.ENGINE_API_ORIGIN = 'https://engine.example';
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await request('/api/engine/snapshot')).code, 502);
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
