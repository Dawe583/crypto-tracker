import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { config } from '../src/config.js';
import { GOLD_ASSETS, scanGold, startGoldLoop } from '../src/gold_rwa.js';
import { classify } from '../src/gold_rwa.js';

test('a stalled DEX request does not prevent a valid asset from refreshing', async (t) => {
  const [paxg, xaut] = GOLD_ASSETS;
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 5_000);
    return timeout(5);
  });
  let timedOut = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.ok(init?.signal);
    if (url === config.gold.spotUrl) return Response.json({ price: 100 });
    const address = url.split('/').at(-1);
    if (address === paxg.address) {
      await setTimeout(250, undefined, { signal: init.signal }).catch((err) => {
        timedOut = err.cause?.name === 'TimeoutError';
        throw err;
      });
    }
    if (address !== xaut.address) return new Response(null, { status: 503 });
    return Response.json({ pairs: [
      { chainId: xaut.chain, baseToken: { address: paxg.address }, quoteToken: { address }, priceUsd: '130', liquidity: { usd: 100_000 } },
      { chainId: xaut.chain, baseToken: { address }, priceUsd: 'NaN', liquidity: { usd: 50_000 } },
      { chainId: xaut.chain, baseToken: { address }, priceUsd: '99', liquidity: { usd: 20_000 } },
    ] });
  });

  const quotes = await scanGold();
  assert.equal(timedOut, true);
  assert.deepEqual(quotes.map((q) => [q.symbol, q.dexPriceUsd]), [['XAUT', 99]]);
});

test('thin gold pairs do not produce spread signals', async (t) => {
  const [paxg, xaut] = GOLD_ASSETS;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === config.gold.spotUrl) return Response.json({ price: 100 });
    const address = url.split('/').at(-1);
    if (address === paxg.address) return new Response(null, { status: 503 });
    if (address !== xaut.address) return new Response(null, { status: 404 });
    return Response.json({ pairs: [{
      chainId: xaut.chain, baseToken: { address }, priceUsd: '90', liquidity: { usd: 19_999 },
    }] });
  });
  assert.deepEqual(await scanGold(), []);
});

test('reversed gold thresholds cannot turn small spreads into major alerts', (t) => {
  const alertPct = config.gold.alertPct;
  const majorPct = config.gold.majorPct;
  t.after(() => { config.gold.alertPct = alertPct; config.gold.majorPct = majorPct; });
  config.gold.alertPct = 2;
  config.gold.majorPct = 1;
  assert.equal(classify(1.5), 'none');
  assert.equal(classify(2.1), 'major');
  config.gold.alertPct = -1;
  config.gold.majorPct = -2;
  assert.equal(classify(0.6), 'alert');
  assert.equal(classify(1.6), 'major');
});

test('scheduled gold polls do not overlap', async (t) => {
  let tick!: () => Promise<void>;
  let requests = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(globalThis, 'setInterval', (callback: typeof tick) => { tick = callback; });
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    await waiting;
    return new Response(null, { status: 503 });
  });

  startGoldLoop();
  const overlap = tick();
  try {
    assert.equal(requests, 1);
  } finally {
    release();
    await overlap;
    await setImmediate();
  }
  await tick();
  assert.equal(requests, 2);
});
