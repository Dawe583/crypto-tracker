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

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'crypto-tracker-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  mkdirSync(join(root, 'data'));
  const strategies = Object.fromEntries(LIBRARY.map(({ name }) => [name, { enabled: name === 'ema_cross' }]));
  writeFileSync(join(root, 'data', 'strategies.json'), JSON.stringify(strategies));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  return root;
}

function runProcess(root: string, ts: number, prices: Record<string, number>, symbols = 'BTCUSDT,ETHUSDT') {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    Date.now = () => ${ts};
    const prices = ${JSON.stringify(prices)};
    globalThis.fetch = async (url) => {
      const price = prices[new URL(url).searchParams.get('symbol')];
      const candles = Array.from({ length: 40 }, (_, i) =>
        i === 39 ? [i * 60_000, 100, price + 1, 99, price, 1000] : [i * 60_000, 100, 101, 99, 100, 100]);
      return Response.json(candles);
    };
    const { runEngineCycle } = await import('./src/engine/loop.ts');
    const { engineState } = await import('./src/engine/state.ts');
    await runEngineCycle();
    console.log(JSON.stringify(engineState.snapshot));
  `], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env, LOG_LEVEL: 'silent',
      ENGINE_SYMBOLS: symbols, ENGINE_START_USD: '10000', ENGINE_FEE_PCT: '0.1',
      ENGINE_MAX_POSITION_USD: '500', ENGINE_MAX_TOTAL_USD: '1000', ENGINE_MAX_OPEN_POSITIONS: '8',
      ENGINE_MIN_CONFIDENCE: '0.5', ENGINE_DAILY_LOSS_PCT: '5', ENGINE_COOLDOWN_MIN: '60',
    },
  });
}

function runCycle(root: string, ts: number, prices: Record<string, number>, symbols?: string): EngineSnapshot {
  const result = runProcess(root, ts, prices, symbols);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const today = Date.UTC(2026, 10, 24, 23, 58);
const tomorrow = today + 3 * 60_000;

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
