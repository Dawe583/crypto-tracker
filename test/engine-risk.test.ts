import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIBRARY } from '../src/strategies/library.js';

async function runCycle(t: TestContext, overrides: Record<string, string>, sizeUsd = 300, price = 110) {
  const root = mkdtempSync(join(tmpdir(), 'crypto-tracker-risk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  mkdirSync(join(root, 'data'));
  const strategies = Object.fromEntries(LIBRARY.map(({ name }) => [name, { enabled: name === 'ema_cross' }]));
  writeFileSync(join(root, 'data', 'strategies.json'), JSON.stringify({
    ...strategies,
    ema_cross: { enabled: true, params: { sizeUsd } },
  }));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');

  const env = {
    ENGINE_SYMBOLS: 'BTCUSDT,ETHUSDT',
    ENGINE_START_USD: '10000',
    ENGINE_MAX_POSITION_USD: '500',
    ENGINE_MAX_TOTAL_USD: '450',
    ENGINE_MAX_OPEN_POSITIONS: '8',
    ENGINE_MIN_CONFIDENCE: '0.5',
    ENGINE_DAILY_LOSS_PCT: '5',
    ENGINE_FEE_PCT: '0.1',
    ...overrides,
  };
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);

  const candles = Array.from({ length: 70 }, (_, i) =>
    i === 69 ? [i * 60_000, 100, price + 1, 99, price, 1000] : [i * 60_000, 100, 101, 99, 100, 100]);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(new URL(url).hostname, 'api.binance.com');
    return Response.json(candles);
  });

  const { runEngineCycle } = await import(pathToFileURL(join(root, 'src/engine/loop.ts')).href) as typeof import('../src/engine/loop.js');
  const { engineState } = await import(pathToFileURL(join(root, 'src/engine/state.ts')).href) as typeof import('../src/engine/state.js');
  await runEngineCycle();
  return engineState;
}

test('checks exposure again after a paper fill in the same cycle', async (t) => {
  const state = await runCycle(t, {});
  assert.deepEqual(state.snapshot?.positions.map((p) => p.symbol), ['BTCUSDT']);
  assert.equal(state.decisions.find((d) => d.strategy === 'ema_cross' && d.symbol === 'ETHUSDT')?.vetoed, 'total exposure cap');
});

test('counts a paper fill fee toward the daily loss breaker in the same cycle', async (t) => {
  const state = await runCycle(t, {
    ENGINE_START_USD: '500',
    ENGINE_MAX_TOTAL_USD: '10000',
    ENGINE_DAILY_LOSS_PCT: '1',
    ENGINE_FEE_PCT: '2',
  });
  assert.deepEqual(state.snapshot?.positions.map((p) => p.symbol), ['BTCUSDT']);
  assert.equal(state.decisions.find((d) => d.strategy === 'ema_cross' && d.symbol === 'ETHUSDT')?.vetoed, 'daily loss breaker (1%)');
});

test('allows same-cycle entries that exactly reach the exposure cap', async (t) => {
  const state = await runCycle(t, { ENGINE_MAX_TOTAL_USD: '499.82' }, 249.91, 101.12);
  assert.deepEqual(state.snapshot?.positions.map((p) => p.symbol), ['BTCUSDT', 'ETHUSDT']);
});
