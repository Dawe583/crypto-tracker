import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EngineSnapshot } from '../src/engine/state.js';
import { LIBRARY } from '../src/strategies/library.js';

function fixture(t: TestContext, enabledStrategy = 'ema_cross') {
  const root = mkdtempSync(join(tmpdir(), 'crypto-tracker-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  mkdirSync(join(root, 'data'));
  const strategies = Object.fromEntries(LIBRARY.map(({ name }) => [name, { enabled: name === enabledStrategy }]));
  writeFileSync(join(root, 'data', 'strategies.json'), JSON.stringify(strategies));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  return root;
}

function runProcess(root: string, ts: number, prices: Record<string, number>, symbols = 'BTCUSDT,ETHUSDT', env?: Record<string, string>,
  script = 'await runEngineCycle(); console.log(JSON.stringify(engineState.snapshot));') {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    let now = ${ts};
    globalThis.Date = new Proxy(Date, {
      construct: (RealDate, args) => new RealDate(...(args.length ? args : [now])),
    });
    Date.now = () => now;
    const prices = ${JSON.stringify(prices)};
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const price = prices[new URL(url).searchParams.get('symbol')];
      if (price === undefined) return new Response(null, { status: 503 });
      const candles = Array.from({ length: 40 }, (_, i) => {
        const time = now - (39 - i) * 60_000;
        return i === 39 ? [time, 100, price + 1, 99, price, 1000] : [time, 100, 101, 99, 100, 100];
      });
      return Response.json(candles);
    };
    const { runEngineCycle } = await import('./src/engine/loop.ts');
    const { engineState } = await import('./src/engine/state.ts');
    ${script}
  `], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env, LOG_LEVEL: 'silent', TZ: 'UTC',
      ENGINE_SYMBOLS: symbols, ENGINE_INTERVAL: '1m', ENGINE_START_USD: '10000', ENGINE_FEE_PCT: '0.1',
      ENGINE_MAX_POSITION_USD: '500', ENGINE_MAX_TOTAL_USD: '1000', ENGINE_MAX_OPEN_POSITIONS: '8',
      ENGINE_MIN_CONFIDENCE: '0.5', ENGINE_DAILY_LOSS_PCT: '5', ENGINE_COOLDOWN_MIN: '60',
      ...env,
    },
  });
}

function runCycle(...args: Parameters<typeof runProcess>): EngineSnapshot {
  const result = runProcess(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const today = Date.UTC(2026, 10, 24, 23, 58);
const tomorrow = today + 3 * 60_000;

test('a local restart retains a trailing peak recorded without a fill', (t) => {
  const root = fixture(t, 'none');
  const seed = runProcess(root, today, {}, 'BTCUSDT', {}, `
    const { portfolio, risk } = await import('./src/engine/loop.ts');
    const { ledgerAppend } = await import('./src/engine/ledger.ts');
    portfolio.open({ strategy: 'managed', symbol: 'BTCUSDT', side: 'buy', confidence: 1,
      reason: 'fixture', sizeUsd: 100, stopLossPct: 1, takeProfitPct: 10, maxHoldMin: 60,
      management: { riskPct: 0.25, trailAfterPct: 1 } }, 100, 0.1, now);
    ledgerAppend('checkpoint', { checkpoint: { portfolio: portfolio.checkpoint(), risk: risk.checkpoint(), stats: [] } });
  `);
  assert.equal(seed.status, 0, seed.stderr);
  const peak = runCycle(root, today + 60_000, { BTCUSDT: 104 }, 'BTCUSDT');
  assert.equal(peak.positions[0].trailing?.peak, 104);
  const stopped = runCycle(root, today + 120_000, { BTCUSDT: 102 }, 'BTCUSDT');
  assert.equal(stopped.positions.length, 0);
  assert.equal(stopped.stats.managed.trades, 1);
});

test('does not fill a max-hold exit from cached candles during a total outage', (t) => {
  const result = runProcess(fixture(t), today, { BTCUSDT: 101.12 }, 'BTCUSDT', {}, `
    import assert from 'node:assert/strict';
    const { getFeed } = await import('./src/engine/market.ts');
    await runEngineCycle();
    const original = engineState.snapshot;
    assert.equal(original.positions.length, 1);

    delete prices.BTCUSDT;
    now += 13 * 3600_000;
    await runEngineCycle();
    assert.deepEqual(engineState.snapshot, original);
    assert.equal(getFeed('BTCUSDT').price, 101.12);
    assert.equal(engineState.halted, false);

    prices.BTCUSDT = 100;
    await runEngineCycle();
    assert.equal(engineState.snapshot.positions.length, 0);
    assert.equal(engineState.snapshot.stats.ema_cross.trades, 1);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('does not open a new trade while a held symbol has no current quote', (t) => {
  const result = runProcess(fixture(t), today, { BTCUSDT: 101.12, ETHUSDT: 100 }, undefined, {}, `
    import assert from 'node:assert/strict';
    await runEngineCycle();
    delete prices.BTCUSDT;
    prices.ETHUSDT = 110;
    await runEngineCycle();
    assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['BTCUSDT']);
    assert.deepEqual(engineState.snapshot.prices, { BTCUSDT: 101.12, ETHUSDT: 110 });
    assert.equal(engineState.snapshot.positions[0].markPrice, 101.12);
    assert.equal(engineState.snapshot.equityCurve.length, 1);
    assert.equal(engineState.decisions[0].vetoed, 'market price unavailable for an open position');

    prices.BTCUSDT = 100;
    await runEngineCycle();
    assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['BTCUSDT', 'ETHUSDT']);

    delete prices.BTCUSDT;
    prices.ETHUSDT = 120;
    await runEngineCycle();
    assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['BTCUSDT']);
    assert.equal(engineState.snapshot.stats.ema_cross.trades, 1);
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('does not open a trade from a cached entry signal when another symbol still refreshes', (t) => {
  const result = runProcess(fixture(t), today, { BTCUSDT: 100, ETHUSDT: 110 }, undefined, {}, `
    import assert from 'node:assert/strict';
    import { writeFileSync, rmSync } from 'node:fs';
    const { risk } = await import('./src/engine/loop.ts');
    writeFileSync('./data/KILL', '');
    await runEngineCycle();
    assert.equal(engineState.snapshot.positions.length, 0);
    assert.match(engineState.decisions[0].vetoed, /kill switch/);

    rmSync('./data/KILL');
    risk.killed = false;
    delete prices.ETHUSDT;
    await runEngineCycle();
    assert.equal(engineState.snapshot.positions.length, 0);
    assert.equal(engineState.decisions.length, 1);
    assert.deepEqual(engineState.snapshot.prices, { BTCUSDT: 100, ETHUSDT: 110 });
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('does not start another scheduled cycle while the first refresh is pending', (t) => {
  const result = runProcess(fixture(t), today, { BTCUSDT: 100 }, 'BTCUSDT', {}, `
    import assert from 'node:assert/strict';
    const { startEngineLoop } = await import('./src/engine/loop.ts');
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const fetchCandles = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (...args) => {
      requests++;
      await promise;
      return fetchCandles(...args);
    };
    let tick;
    globalThis.setInterval = (callback) => { tick = callback; };
    startEngineLoop();
    const overlap = tick();
    assert.equal(requests, 1);
    resolve();
    await overlap;
    await new Promise(setImmediate);
    assert.ok(engineState.snapshot);
    await tick();
    assert.equal(requests, 2);
  `);
  assert.equal(result.status, 0, result.stderr);
});

function checkSnapshotApi(root: string, assertions: string) {
  const result = runProcess(root, today, { BTCUSDT: 101.12 }, 'BTCUSDT', {
    API_ENABLED: 'true', API_HOST: '127.0.0.1', API_PORT: '0', API_TOKEN: '',
  }, `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { mkdirSync, rmSync } from 'node:fs';
    const { startApi } = await import('./src/api.ts');
    const server = startApi();
    await once(server, 'listening');
    const snapshot = async () => {
      const response = await realFetch('http://127.0.0.1:' + server.address().port + '/api/engine/snapshot');
      assert.equal(response.status, 200);
      return response.json();
    };
    try {
      ${assertions}
    } finally {
      server.close();
    }
  `);
  assert.equal(result.status, 0, result.stderr);
}

test('gold API retains cached quotes without feeding stale spreads into paper trading', (t) => {
  const result = runProcess(fixture(t, 'gold_spread'), today, { PAXGUSD: 100, XAUTUSD: 100 }, 'PAXGUSD,XAUTUSD', {
    API_ENABLED: 'true', API_HOST: '127.0.0.1', API_PORT: '0', API_TOKEN: '', GOLD_POLL_MS: '60000',
    GOLD_ALERT_PCT: '0.5', GOLD_MAJOR_PCT: '1.5', GOLD_SPOT_URL: 'https://spot.test/',
    BASE_PAXG_ADDRESS: '', BASE_XAUT_ADDRESS: '', TELEGRAM_BOT_TOKEN: '', ALERT_WEBHOOK_URL: '',
  }, `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    const { GOLD_ASSETS, runGoldCycle } = await import('./src/gold_rwa.ts');
    const { startApi } = await import('./src/api.ts');
    const marketFetch = globalThis.fetch;
    const dexPrices = { PAXG: 98, XAUT: 100 };
    let spotAvailable = true;
    globalThis.fetch = async (url, init) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === 'spot.test') {
        return spotAvailable ? Response.json({ price: 100 }) : new Response(null, { status: 503 });
      }
      if (hostname !== 'api.dexscreener.com') return marketFetch(url, init);
      const address = pathname.split('/').at(-1);
      const asset = GOLD_ASSETS.find((item) => item.address === address);
      const price = dexPrices[asset.symbol];
      if (price === undefined) return new Response(null, { status: 503 });
      return Response.json({ pairs: [{
        chainId: asset.chain, baseToken: { address }, priceUsd: String(price), liquidity: { usd: 100_000 },
      }] });
    };
    const server = startApi();
    await once(server, 'listening');
    const gold = async () => {
      const response = await realFetch('http://127.0.0.1:' + server.address().port + '/api/gold');
      assert.equal(response.status, 200);
      return response.json();
    };
    try {
      await runGoldCycle();
      const initial = await gold();
      assert.equal(initial.assets.length, 2);

      now += 60_000;
      delete dexPrices.PAXG;
      dexPrices.XAUT = 98;
      await runGoldCycle();
      const partial = await gold();
      assert.equal(partial.assets.length, 2);
      assert.equal(partial.stale, false);
      const paxg = partial.assets.find((quote) => quote.symbol === 'PAXG');
      assert.deepEqual(paxg, { ...initial.assets.find((quote) => quote.symbol === 'PAXG'), stale: true });
      assert.equal(paxg.updatedAt, initial.updatedAt);
      assert.equal(partial.assets.find((quote) => quote.symbol === 'XAUT').stale, false);
      await runEngineCycle();
      assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['XAUTUSD']);

      now += 60_000;
      dexPrices.XAUT = 100;
      await runGoldCycle();
      const beforeOutage = await gold();
      assert.equal(beforeOutage.stale, false);

      now += 60_000;
      spotAvailable = false;
      await runGoldCycle();
      const outage = await gold();
      assert.equal(outage.attemptedAt, new Date(now).toISOString());
      assert.equal(outage.updatedAt, beforeOutage.updatedAt);
      assert.equal(outage.stale, true);
      assert.deepEqual(outage.assets, beforeOutage.assets.map((quote) => ({ ...quote, stale: true })));
      await runEngineCycle();
      assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['XAUTUSD']);

      now += 60_000;
      spotAvailable = true;
      await runGoldCycle();
      assert.equal((await gold()).stale, false);
      now += 180_001;
      assert.equal((await gold()).stale, true);
      await runEngineCycle();
      assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['XAUTUSD']);

      dexPrices.PAXG = 98;
      await runGoldCycle();
      assert.ok((await gold()).assets.every((quote) => !quote.stale));
      await runEngineCycle();
      assert.deepEqual(engineState.snapshot.positions.map((p) => p.symbol), ['PAXGUSD']);
    } finally {
      server.close();
    }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('snapshot API reports a ledger recovery halt before the first cycle', (t) => {
  const root = fixture(t);
  const directory = join(root, 'data', 'ledger');
  mkdirSync(directory);
  writeFileSync(join(directory, '2026-11-24.jsonl'), '{"seq":');
  checkSnapshotApi(root, `
    assert.deepEqual(await snapshot(), { empty: true, halted: false });
    await assert.rejects(runEngineCycle(), /incomplete paper ledger/);
    assert.deepEqual(await snapshot(), { empty: true, halted: true });
  `);
});

test('snapshot API reports immediate stop state without losing the independent halt flag', (t) => {
  checkSnapshotApi(fixture(t), `
    await runEngineCycle();
    const healthy = await snapshot();
    assert.equal(healthy.halted, false);
    assert.equal(healthy.killed, false);
    mkdirSync('./data/KILL');
    assert.deepEqual(await snapshot(), { ...healthy, killed: true });
    engineState.halted = true;
    assert.deepEqual(await snapshot(), { ...healthy, killed: true, halted: true });
  `);
});

test('snapshot API reports a ledger append halt alongside the last good snapshot', (t) => {
  checkSnapshotApi(fixture(t), `
    await runEngineCycle();
    const healthy = await snapshot();
    assert.equal(healthy.halted, false);
    assert.equal(healthy.killed, false);
    assert.equal(healthy.positions.length, 1);
    const file = './data/ledger/2026-11-24.jsonl';
    rmSync(file);
    mkdirSync(file);
    await assert.rejects(runEngineCycle(), /EISDIR/);
    assert.deepEqual(await snapshot(), { ...healthy, halted: true });
    await assert.rejects(runEngineCycle(), /restart required/);
  `);
});

test('restores positions with their original exits and accounting across a UTC rollover', (t) => {
  const root = fixture(t);
  const original = runCycle(root, today, { BTCUSDT: 101.12, ETHUSDT: 100 });
  assert.equal(original.positions[0]?.id, 'p1');

  const restored = runCycle(root, tomorrow, { BTCUSDT: 100, ETHUSDT: 100 });
  // Above the original stop, but flat candles cannot recreate the entry.
  assert.deepEqual(restored.positions.map(({ id, symbol }) => [id, symbol]), [['p1', 'BTCUSDT']]);
  assert.equal(restored.positions[0]?.entryTs, original.positions[0]?.entryTs);
  assert.equal(restored.positions[0]?.stopLossPct, original.positions[0]?.stopLossPct);
  assert.equal(restored.positions[0]?.takeProfitPct, original.positions[0]?.takeProfitPct);
  assert.equal(restored.positions[0]?.maxHoldMin, original.positions[0]?.maxHoldMin);
  assert.equal(restored.cashUsd, original.cashUsd);
  assert.equal(restored.feesUsd, original.feesUsd);
  const previous = JSON.parse(readFileSync(join(root, 'data', 'ledger', '2026-11-24.jsonl'), 'utf8').trim().split('\n').at(-1)!);
  const first = JSON.parse(readFileSync(join(root, 'data', 'ledger', '2026-11-25.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(first.seq, previous.seq + 1);
  assert.equal(first.prevHash, previous.hash);

  const next = runCycle(root, tomorrow + 60_000, { BTCUSDT: 120, ETHUSDT: 110 }, 'ETHUSDT');
  assert.deepEqual(next.positions.map(({ id, symbol }) => [id, symbol]), [['p2', 'ETHUSDT']]);
  assert.ok(next.realizedUsd > 0);
  assert.equal(next.stats.ema_cross?.trades, 1);
  assert.equal(next.stats.ema_cross?.wins, 1);

  const afterClose = runCycle(root, tomorrow + 120_000, { BTCUSDT: 100, ETHUSDT: 110 });
  assert.deepEqual(afterClose.positions, next.positions);
  assert.equal(afterClose.realizedUsd, next.realizedUsd);
  assert.deepEqual(afterClose.stats, next.stats);
  assert.equal(afterClose.cashUsd, next.cashUsd);
  assert.equal(afterClose.feesUsd, next.feesUsd);
});

test('does not continue trading after an invalid ledger tail', (t) => {
  const root = fixture(t);
  runCycle(root, today, { BTCUSDT: 110, ETHUSDT: 100 });
  const file = join(root, 'data', 'ledger', '2026-11-24.jsonl');
  const broken = readFileSync(file, 'utf8') + '{"seq":';
  writeFileSync(file, broken);
  const result = runProcess(root, tomorrow, { BTCUSDT: 100, ETHUSDT: 110 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ledger/i);
  assert.equal(readFileSync(file, 'utf8'), broken);
});

test('does not restore an older fill when a newer fill is missing', (t) => {
  const root = fixture(t);
  runCycle(root, today, { BTCUSDT: 101.12, ETHUSDT: 100 });
  runCycle(root, tomorrow, { BTCUSDT: 120, ETHUSDT: 100 }, 'ETHUSDT');
  const file = join(root, 'data', 'ledger', '2026-11-25.jsonl');
  const broken = readFileSync(file, 'utf8').split('\n').filter((line) => !line || JSON.parse(line).type !== 'fill').join('\n');
  writeFileSync(file, broken);
  const result = runProcess(root, tomorrow + 60_000, { BTCUSDT: 100, ETHUSDT: 100 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ledger chain/i);
  assert.equal(readFileSync(file, 'utf8'), broken);
});

test('keeps an exit recorded after the clock moves to an earlier UTC date', (t) => {
  const root = fixture(t);
  runCycle(root, today, { BTCUSDT: 100, ETHUSDT: 100 });
  assert.equal(runCycle(root, tomorrow, { BTCUSDT: 101.12, ETHUSDT: 100 }).positions.length, 1);
  const closed = runCycle(root, today + 60_000, { BTCUSDT: 120, ETHUSDT: 100 }, 'ETHUSDT');
  assert.deepEqual(closed.positions, []);
  const restored = runCycle(root, today + 90_000, { BTCUSDT: 100, ETHUSDT: 100 });
  assert.deepEqual(restored.positions, []);
  assert.equal(restored.realizedUsd, closed.realizedUsd);
});

test('leaves legacy fills intact without guessing missing position state', (t) => {
  const root = fixture(t);
  const directory = join(root, 'data', 'ledger');
  mkdirSync(directory);
  const data = { id: 'p1', strategy: 'ema_cross', symbol: 'BTCUSDT', side: 'buy', qty: 3, price: 100, usd: 300, feeUsd: 0.3, reason: 'legacy', ts: today };
  const hash = createHash('sha256').update(`GENESIS:0:fill:${JSON.stringify(data)}`).digest('hex');
  const row = JSON.stringify({ seq: 0, ts: today, type: 'fill', prevHash: 'GENESIS', hash, data }) + '\n';
  const file = join(directory, '2026-11-24.jsonl');
  writeFileSync(file, row);
  const next = runCycle(root, tomorrow, { BTCUSDT: 100, ETHUSDT: 100 });
  assert.deepEqual(next.positions, []);
  assert.equal(next.cashUsd, 10_000);
  assert.equal(readFileSync(file, 'utf8'), row);
});

function legacyFork(t: TestContext, missingRow = false) {
  const root = fixture(t);
  const directory = join(root, 'data', 'ledger');
  mkdirSync(directory);
  const equity = (seq: number, ts: number, prevHash: string, equityUsd: number) => {
    const data = { equityUsd };
    const type = 'equity';
    const hash = createHash('sha256').update(`${prevHash}:${seq}:${type}:${JSON.stringify(data)}`).digest('hex');
    return { seq, ts, type, prevHash, hash, data };
  };
  const first = equity(0, today, 'GENESIS', 10_000);
  const nextDay = equity(1, tomorrow, first.hash, 10_001);
  const fork = equity(1, today + 60_000, first.hash, 10_002);
  const forkTip = equity(2, today + 90_000, fork.hash, 10_003);
  const earlier = join(directory, '2026-11-24.jsonl');
  const later = join(directory, '2026-11-25.jsonl');
  const earlierRecords = missingRow ? [first, forkTip] : [first, fork, forkTip];
  const earlierContents = earlierRecords.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(earlier, earlierContents);
  writeFileSync(later, JSON.stringify(nextDay) + '\n');
  return { root, directory, earlier, earlierContents, later, nextDay, forkTip, equity };
}

test('opens an intact legacy ledger with a fork from a clock rollback', (t) => {
  const { root, earlier, earlierContents, later, nextDay } = legacyFork(t);
  assert.deepEqual(runCycle(root, tomorrow + 60_000, { BTCUSDT: 100, ETHUSDT: 100 }).positions, []);
  assert.equal(readFileSync(earlier, 'utf8'), earlierContents);
  const resumed = JSON.parse(readFileSync(later, 'utf8').split('\n')[1]);
  assert.equal(resumed.seq, nextDay.seq + 1);
  assert.equal(resumed.prevHash, nextDay.hash);
});

test('rejects a missing row in a legacy fork', (t) => {
  const { root, earlier, earlierContents } = legacyFork(t, true);
  const result = runProcess(root, tomorrow + 60_000, { BTCUSDT: 100, ETHUSDT: 100 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ledger chain/i);
  assert.equal(readFileSync(earlier, 'utf8'), earlierContents);
});

test('follows a legacy chain that skips a UTC date after rollback', (t) => {
  const { root, directory, forkTip, equity } = legacyFork(t);
  const dayThree = tomorrow + 86_400_000;
  const row = equity(3, dayThree, forkTip.hash, 10_004);
  const file = join(directory, '2026-11-26.jsonl');
  writeFileSync(file, JSON.stringify(row) + '\n');

  assert.deepEqual(runCycle(root, dayThree + 60_000, { BTCUSDT: 100, ETHUSDT: 100 }).positions, []);
  const resumed = JSON.parse(readFileSync(file, 'utf8').split('\n')[1]);
  assert.equal(resumed.prevHash, row.hash);
});

test('keeps a strategy on cooldown after restarting', (t) => {
  const root = fixture(t);
  for (let i = 0; i < 2; i++) {
    const ts = tomorrow + i * 120_000;
    assert.equal(runCycle(root, ts, { BTCUSDT: 110, ETHUSDT: 100 }).positions.length, 1);
    assert.equal(runCycle(root, ts + 60_000, { BTCUSDT: 90, ETHUSDT: 100 }).positions.length, 0);
  }
  const skipped = runCycle(root, tomorrow + 240_000, { BTCUSDT: 110, ETHUSDT: 100 });
  assert.deepEqual(skipped.positions, []);
  assert.equal(skipped.stats.ema_cross?.trades, 2);
  const ledger = readFileSync(join(root, 'data', 'ledger', '2026-11-25.jsonl'), 'utf8');
  assert.match(ledger, /strategy cooldown until/);
});

test('keeps the new daily loss baseline after a cycle with no fill', (t) => {
  const root = fixture(t);
  const lossLimit = { ENGINE_DAILY_LOSS_PCT: '0.05' };
  runCycle(root, today, { BTCUSDT: 110, ETHUSDT: 100 });
  const vetoed = runCycle(root, tomorrow, { BTCUSDT: 115, ETHUSDT: 110 }, undefined, {
    ...lossLimit, ENGINE_MAX_OPEN_POSITIONS: '1',
  });
  assert.deepEqual(vetoed.positions.map(({ symbol }) => symbol), ['BTCUSDT']);

  const restarted = runCycle(root, tomorrow + 60_000, { BTCUSDT: 111, ETHUSDT: 110 }, undefined, lossLimit);
  assert.deepEqual(restarted.positions.map(({ symbol }) => symbol), ['BTCUSDT']);
  const ledger = readFileSync(join(root, 'data', 'ledger', '2026-11-25.jsonl'), 'utf8');
  assert.match(ledger, /max open positions/);
  assert.match(ledger, /daily loss breaker/);
});

test('does not set a new daily loss baseline while the kill switch is on', (t) => {
  const root = fixture(t);
  const lossLimit = { ENGINE_DAILY_LOSS_PCT: '0.05' };
  runCycle(root, today, { BTCUSDT: 110, ETHUSDT: 100 });
  const kill = join(root, 'data', 'KILL');
  writeFileSync(kill, 'on');
  const halted = runCycle(root, tomorrow, { BTCUSDT: 115, ETHUSDT: 110 }, undefined, lossLimit);
  assert.equal(halted.killed, true);
  assert.deepEqual(halted.positions.map(({ symbol }) => symbol), ['BTCUSDT']);
  rmSync(kill);

  const resumed = runCycle(root, tomorrow + 60_000, { BTCUSDT: 111, ETHUSDT: 110 }, undefined, lossLimit);
  assert.deepEqual(resumed.positions.map(({ symbol }) => symbol), ['BTCUSDT', 'ETHUSDT']);
});
