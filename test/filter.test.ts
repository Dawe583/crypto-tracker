import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { checkHoneypot, checkVerified, getMarket } from '../src/filter.js';

const token = '0x0000000000000000000000000000000000000001';

test('external safety lookups use bounded abortable requests', async (t) => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const seen: string[] = [];
  AbortSignal.timeout = (ms: number) => {
    assert.equal(ms, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0).unref();
    return controller.signal;
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    seen.push(String(url));
    return Response.json({ pairs: [], honeypotResult: {}, simulationResult: {}, result: [{}] });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  });

  await getMarket('base', token);
  await checkHoneypot('base', token);
  config.basescanKey = 'test-key';
  await checkVerified('base', token);
  config.basescanKey = '';
  assert.equal(seen.length, 3);
});
