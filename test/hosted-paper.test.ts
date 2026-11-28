import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { hostedCron, hostedRead, resetHostedCandleCacheForTests } from '../src/engine/hosted-api.js';
import { runHostedCycle } from '../src/engine/hosted.js';
import type { Feed } from '../src/engine/market.js';
import type { ActiveStrategy } from '../src/strategies/registry.js';

type Store = Parameters<typeof runHostedCycle>[0];
type Commit = Parameters<Store['commit']>[0];

function memoryStore() {
  let head: Awaited<ReturnType<Store['load']>> = { slot: -1, seq: -1, hash: 'GENESIS', checkpoint: null, deck: {} };
  const writes: Commit[] = [];
  const store: Store = {
    load: async () => structuredClone(head),
    async commit(cycle) {
      if (cycle.p_slot <= head.slot || cycle.p_seq !== head.seq || cycle.p_hash !== head.hash) return false;
      for (const record of cycle.p_records) {
        assert.equal(record.seq, head.seq + 1);
        assert.equal(record.prevHash, head.hash);
        assert.equal(record.hash, createHash('sha256').update(`${record.prevHash}:${record.seq}:${record.type}:${record.payload}`).digest('hex'));
        head.seq = record.seq;
        head.hash = record.hash;
      }
      writes.push(structuredClone(cycle));
      head = { ...head, slot: cycle.p_slot, checkpoint: cycle.p_checkpoint, deck: cycle.p_deck };
      return true;
    },
  };
  return { store, writes };
}

const refreshAt = (price: number) => async (): Promise<Feed> => ({
  source: 'coinbase', price, lastFetch: Date.now(),
  candles: Array.from({ length: 35 }, (_, t) => ({ t, o: price, h: price, l: price, c: price, v: 1 })),
});
const strategies: ActiveStrategy[] = [{
  enabled: true, params: {},
  strategy: {
    name: 'fixture', description: '', defaults: {},
    evaluate: ({ symbol }) => symbol === 'BTCUSDT' ? [{
      strategy: 'fixture', symbol, side: 'buy', confidence: 1, sizeUsd: 100, takeProfitPct: 5, reason: 'fixture',
    }] : [],
  },
}];

test('hosted cycles restore positions and keep one ledger chain across invocations', async () => {
  const { store, writes } = memoryStore();
  assert.equal(await runHostedCycle(store, 1, refreshAt(100), strategies), true);
  assert.equal(writes[0].p_deck.snapshot.positions.length, 1);
  assert.equal(await runHostedCycle(store, 2, refreshAt(110), []), true);
  const { snapshot } = writes[1].p_deck;
  assert.equal(snapshot.positions.length, 0);
  assert.equal(snapshot.equityCurve.length, 2);
  assert.ok(snapshot.realizedUsd > 0);
  assert.equal(snapshot.stats.fixture.trades, 1);
  assert.equal(writes[1].p_records[0].prevHash, writes[0].p_records.at(-1)?.hash);
});


test('hosted deck state excludes cacheable public candles', async () => {
  const { store, writes } = memoryStore();
  assert.equal(await runHostedCycle(store, 1, refreshAt(100), []), true);
  assert.equal('candles' in writes[0].p_deck, false);
});

test('duplicate and stale cron slots cannot post a second cycle', async () => {
  const { store, writes } = memoryStore();
  const results = await Promise.all([runHostedCycle(store, 2, refreshAt(100), []), runHostedCycle(store, 2, refreshAt(100), [])]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await runHostedCycle(store, 1, refreshAt(100), []), false);
  await assert.rejects(runHostedCycle(store, 3, async () => null, []), /No paper engine market feed/);
  assert.equal(writes.length, 1);
});

test('restores the trailing high-water mark and does not reuse the signal candle after a stop', async () => {
  const { store, writes } = memoryStore();
  const minute = 60_000;
  const lastFetch = Math.floor(Date.now() / minute) * minute + 1000;
  const refresh = (price: number) => async (): Promise<Feed> => ({
    source: 'coinbase', price, lastFetch,
    candles: Array.from({ length: 35 }, (_, i) => ({
      t: lastFetch - 1000 - (34 - i) * minute, o: 100, h: 100, l: 100, c: 100, v: 1,
    })),
  });
  const [fixture] = strategies;
  const managed: ActiveStrategy = { ...fixture,
    strategy: { ...fixture.strategy, closedBars: 30, evaluate: (ctx) => fixture.strategy.evaluate(ctx).map((intent) => ({
      ...intent, stopLossPct: 0.6, takeProfitPct: 1.2, maxHoldMin: 100, management: { riskPct: 0.25, trailAfterPct: 0.6 },
    })) },
  };
  assert.equal(await runHostedCycle(store, 1, refresh(100), [managed]), true);
  assert.equal(writes[0].p_checkpoint.portfolio.positions[0].entryPrice, 100.03);
  assert.equal(await runHostedCycle(store, 2, refresh(101), [managed]), true);
  assert.equal(writes[1].p_checkpoint.portfolio.positions[0].trailing?.peak, 101);
  assert.equal(await runHostedCycle(store, 3, refresh(100.25), [managed]), true);
  assert.equal(writes[2].p_checkpoint.portfolio.positions.length, 0);
  const fill = writes[2].p_records.find((r) => r.type === 'fill');
  assert.equal(JSON.parse(fill!.payload).reason, 'trailing stop');
  assert.equal(await runHostedCycle(store, 4, refresh(100), [managed]), true);
  assert.equal(writes[3].p_checkpoint.portfolio.positions.length, 0);
  assert.equal(writes[3].p_deck.decisions.length, 1);
});

test('a disabled strategy can wind down an existing position in a removed market', async (t) => {
  const { store, writes } = memoryStore();
  const original = config.engine.symbols;
  t.after(() => { config.engine.symbols = original; });
  config.engine.symbols = ['BTCUSDT'];
  assert.equal(await runHostedCycle(store, 1, refreshAt(100), strategies), true);
  config.engine.symbols = ['ETHUSDT'];
  const [fixture] = strategies;
  const disabled: ActiveStrategy = { ...fixture, enabled: false,
    strategy: { ...fixture.strategy, evaluate: ({ symbol }) => [
      { strategy: 'fixture', symbol, side: 'sell', confidence: 1, reason: 'legacy exit' },
      { strategy: 'fixture', symbol, side: 'buy', confidence: 1, reason: 'no new positions' },
    ] },
  };
  assert.equal(await runHostedCycle(store, 2, refreshAt(101), [disabled]), true);
  assert.deepEqual(writes[1].p_checkpoint.portfolio.positions, []);
  assert.deepEqual(writes[1].p_records.filter((r) => r.type === 'fill').map((r) => JSON.parse(r.payload).reason), ['legacy exit']);
});

test('an unpriced open position keeps its mark without producing a fresh equity point', async () => {
  const { store, writes } = memoryStore();
  await runHostedCycle(store, 1, refreshAt(100), strategies);
  await runHostedCycle(store, 2, (symbol) => symbol === 'BTCUSDT' ? Promise.resolve(null) : refreshAt(110)(), []);
  const cycle = writes[1];
  assert.equal(cycle.p_deck.snapshot.positions[0]?.markPrice, 100);
  assert.equal(cycle.p_deck.snapshot.equityCurve.length, 1);
  assert.equal(cycle.p_records.at(-1)?.type, 'checkpoint');
});

test('cached quotes stay visible only for configured markets or open positions', async (t) => {
  const original = config.engine.symbols;
  t.after(() => { config.engine.symbols = original; });
  config.engine.symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const { store, writes } = memoryStore();
  await runHostedCycle(store, 1, refreshAt(100), strategies);
  config.engine.symbols = ['ETHUSDT', 'SOLUSDT'];
  await runHostedCycle(store, 2, (symbol) => symbol === 'ETHUSDT' ? refreshAt(110)() : Promise.resolve(null), []);
  assert.deepEqual(writes[1].p_deck.snapshot.prices, { BTCUSDT: 100, ETHUSDT: 110, SOLUSDT: 100 });
  await runHostedCycle(store, 3, refreshAt(110), []);
  assert.deepEqual(writes[2].p_deck.snapshot.prices, { ETHUSDT: 110, SOLUSDT: 110 });
});

test('only a distinct cron secret may write, and the deck routes are GET-only', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected database access'); });
  const previous = { ...process.env };
  Object.assign(process.env, {
    API_TOKEN: 'read-test', CRON_SECRET: 'cron-test', VERCEL_ENV: 'preview',
    SUPABASE_URL: 'https://test.invalid', SUPABASE_SECRET_KEY: 'secret-test',
  });
  t.after(() => { process.env = previous; });
  const url = new URL('https://test.invalid/api/engine/snapshot');
  assert.equal((await hostedRead(new URL('/api/engine/kill', url), 'POST', 'Bearer read-test')).status, 404);
  assert.equal((await hostedRead(url, 'POST', 'Bearer read-test')).status, 405);
  assert.equal((await hostedRead(url, 'GET', 'Bearer cron-test')).status, 401);
  assert.equal((await hostedCron('POST', 'Bearer read-test')).status, 401);
  assert.equal((await hostedCron('POST', 'Bearer cron-test')).status, 503);
  assert.equal((await hostedCron('GET', 'Bearer cron-test')).status, 405);
  assert.equal((await hostedRead(new URL('/api/engine/candles?symbol=bad%2Fsymbol', url), 'GET', 'Bearer read-test')).status, 400);
  process.env.VERCEL_ENV = 'production';
  process.env.CRON_SECRET = 'read-test';
  assert.equal((await hostedCron('POST', 'Bearer read-test')).status, 503);
});


test('hosted candles are fetched once and served outside the paper state payload', async (t) => {
  resetHostedCandleCacheForTests();
  t.after(resetHostedCandleCacheForTests);
  const prev = { ...process.env };
  Object.assign(process.env, { SUPABASE_URL: 'https://storage.invalid', SUPABASE_SECRET_KEY: 'secret-test', API_TOKEN: 'read-test' });
  t.after(() => { process.env = prev; });
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return Response.json(Array.from({ length: 130 }, (_, i) => [now - (129 - i) * 60_000, '100', '101', '99', '100', '1', 0, '0', 0, '0', '0', '0']));
  });
  const url = new URL('https://deck.invalid/api/engine/candles?symbol=BTCUSDT');
  const first = await hostedRead(url, 'GET', 'Bearer read-test');
  const second = await hostedRead(url, 'GET', 'Bearer read-test');
  assert.equal(first.status, 200);
  assert.equal(first.body.candles.length, 120);
  assert.equal(second.body.candles.length, 120);
  assert.equal(fetches, 1);
});

test('the snapshot requires a fresh cycle and does not require an Origin header', async (t) => {
  const prev = { ...process.env };
  Object.assign(process.env, { SUPABASE_URL: 'https://storage.invalid', SUPABASE_SECRET_KEY: 'secret-test', API_TOKEN: 'read-test' });
  t.after(() => { process.env = prev; });
  let snapshot: object | null = null;
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    assert.equal(url.href, 'https://storage.invalid/rest/v1/rpc/paper_engine_read');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { apikey: 'secret-test', 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body as string), { p_key: 'snapshot', p_symbol: null });
    return Response.json(snapshot);
  });
  const request = () => hostedRead(new URL('https://deck.invalid/api/engine/snapshot'), 'GET', 'Bearer read-test');
  assert.equal((await request()).status, 503);
  snapshot = { cycleAt: new Date(Date.now() - 360_000).toISOString(), equityUsd: 10_000 };
  assert.equal((await request()).status, 503);
  snapshot = { cycleAt: new Date().toISOString(), equityUsd: 10_000 };
  assert.deepEqual(await request(), { status: 200, body: { ...snapshot, halted: false } });
});
