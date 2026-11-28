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

test('market lookup ignores deeper pairs where the token is only the quote asset', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    pairs: [
      { chainId: 'base', baseToken: { address: '0x0000000000000000000000000000000000000099' }, priceUsd: '500', liquidity: { usd: 900000 }, pairAddress: 'wrong', dexId: 'dex' },
      { chainId: 'base', baseToken: { address: token }, priceUsd: '2', liquidity: { usd: 30000 }, marketCap: 2000000, pairAddress: 'right', dexId: 'dex' },
    ],
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const market = await getMarket('base', token);
  assert.equal(market?.priceUsd, 2);
  assert.equal(market?.pairAddress, 'right');
});

test('market lookup rejects non-finite and non-positive upstream prices', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    pairs: [
      { chainId: 'base', baseToken: { address: token }, priceUsd: 'Infinity', liquidity: { usd: 900000 }, pairAddress: 'infinite', dexId: 'dex' },
      { chainId: 'base', baseToken: { address: token }, priceUsd: '-5', liquidity: { usd: 800000 }, pairAddress: 'negative', dexId: 'dex' },
      { chainId: 'base', baseToken: { address: token }, priceUsd: '0', liquidity: { usd: 700000 }, pairAddress: 'zero', dexId: 'dex' },
    ],
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  assert.equal(await getMarket('base', token), null);
});

test('market lookup normalizes malformed liquidity and market cap values', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    pairs: [
      { chainId: 'base', baseToken: { address: token }, priceUsd: '3', liquidity: { usd: 'not-a-number' }, marketCap: 'bad', pairAddress: 'malformed', dexId: 'dex' },
    ],
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const market = await getMarket('base', token);
  assert.equal(market?.liquidityUsd, 0);
  assert.equal(market?.marketCapUsd, null);
});
