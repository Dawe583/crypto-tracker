import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RiskEngine } from '../src/engine/risk.js';
import { LIBRARY } from '../src/strategies/library.js';

async function runCycle(
  t: TestContext,
  overrides: Record<string, string>,
  { sizeUsd = 300, price = 110, seedBtc = false } = {},
) {
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
    ENGINE_INTERVAL: '1m',
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

  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const { hostname, searchParams } = new URL(url);
    assert.equal(hostname, 'api.binance.com');
    const lastPrice = seedBtc && searchParams.get('symbol') === 'BTCUSDT' ? 99 : price;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const candles = Array.from({ length: 70 }, (_, i) => {
      const time = now - (69 - i) * 60_000;
      return i >= 68 ? [time, 100, Math.max(100, lastPrice) * 1.01, Math.min(100, lastPrice) * 0.99, lastPrice, 1000] : [time, 100, 101, 99, 100, 100];
    });
    return Response.json(candles);
  });

  const { portfolio, runEngineCycle } = await import(pathToFileURL(join(root, 'src/engine/loop.ts')).href) as typeof import('../src/engine/loop.js');
  const { engineState } = await import(pathToFileURL(join(root, 'src/engine/state.ts')).href) as typeof import('../src/engine/state.js');
  if (seedBtc) {
    assert.ok(portfolio.open({
      strategy: 'ema_cross', symbol: 'BTCUSDT', side: 'buy', confidence: 1, reason: 'test setup', sizeUsd,
    }, 100, 0.1));
  }
  await runEngineCycle();
  return engineState;
}

test('checks exposure again after a paper fill in the same cycle', async (t) => {
  const state = await runCycle(t, {});
  assert.deepEqual(state.snapshot?.positions.map((p) => p.symbol), ['BTCUSDT']);
  assert.equal(state.snapshot?.dayStartEquityUsd, 10_000);
  assert.equal(state.snapshot?.dayStart, new Date().toDateString());
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
  const state = await runCycle(t, { ENGINE_MAX_TOTAL_USD: '499.82' }, { sizeUsd: 249.91, price: 101.12 });
  assert.deepEqual(state.snapshot?.positions.map((p) => p.symbol), ['BTCUSDT', 'ETHUSDT']);
});

test('reuses exposure freed by a strategy sell in the same cycle', async (t) => {
  const state = await runCycle(t, {}, { seedBtc: true });
  assert.deepEqual(state.snapshot?.positions.map((p) => p.symbol), ['ETHUSDT']);
  assert.deepEqual(state.decisions.map(({ symbol, action, vetoed }) => [symbol, action, vetoed]), [
    ['ETHUSDT', 'buy', undefined],
    ['BTCUSDT', 'sell', undefined],
  ]);
});


test('daily loss breaker triggers at the configured threshold boundary', () => {
  const cfg = { maxPositionUsd: 500, maxTotalUsd: 1000, maxOpenPositions: 8, dailyLossPct: 5, minConfidence: 0.5, cooldownMin: 60, startEquityUsd: 10_000 };
  const risk = new RiskEngine(cfg, Date.UTC(2026, 0, 1), false);
  const intent = { strategy: 'fixture', symbol: 'BTCUSDT', side: 'buy' as const, confidence: 1, reason: 'boundary', sizeUsd: 100 };
  assert.equal(risk.check(intent, [], 9_500, 0, Date.UTC(2026, 0, 1)), 'daily loss breaker (5%)');
});

test('rolls the daily baseline without waiting for a buy intent', () => {
  const cfg = { maxPositionUsd: 500, maxTotalUsd: 1000, maxOpenPositions: 8, dailyLossPct: 5, minConfidence: 0.5, cooldownMin: 60, startEquityUsd: 10_000 };
  const first = Date.UTC(2026, 0, 1, 23, 0);
  const next = Date.UTC(2026, 0, 2, 0, 1);
  const risk = new RiskEngine(cfg, first, false);
  assert.equal(risk.baselineEquity, 10_000);
  risk.rollDay(9_750, next);
  assert.equal(risk.baselineDay, new Date(next).toDateString());
  assert.equal(risk.baselineEquity, 9_750);
  risk.rollDay(9_800, next + 60_000);
  assert.equal(risk.baselineEquity, 9_750);
});
