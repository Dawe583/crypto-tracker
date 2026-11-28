import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { replayOne, runBacktest } from '../src/engine/backtest.js';
import { runStress } from '../src/engine/stress.js';
import { runSweep } from '../src/engine/sweep.js';
import { managedSize } from '../src/engine/execution.js';
import { closedStrategyBars } from '../src/engine/market.js';
import { PaperPortfolio } from '../src/engine/portfolio.js';
import type { Candle, Strategy, TradeIntent } from '../src/engine/types.js';
import { macdBb } from '../src/strategies/macd-bb.js';
import { loadStrategies } from '../src/strategies/registry.js';

const minute = 60_000;
const symbol = 'BTCUSDT';
const bar = (i: number, c: number, o = c): Candle => ({ t: i * minute, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: 1 });
const reversal = Array.from({ length: 120 }, (_, i) =>
  bar(i, 100 - Math.max(0, i - 99) * 0.05 - (i >= 96 ? 1 : 0) + Math.max(0, i - 96) * 0.04));

test('only the sourced controller opens by default; it needs both Bollinger and MACD conditions', () => {
  assert.deepEqual(loadStrategies().filter(({ enabled }) => enabled).map(({ strategy }) => strategy.name), [macdBb.name]);
  assert.deepEqual(loadStrategies({}).filter(({ enabled }) => enabled), []);
  const ctx = { symbol, price: 100, candles: reversal, positions: [], params: macdBb.defaults,
    signals: { whaleBuys: 0, newPools: 0, goldSpread: {} } };
  const [entry] = macdBb.evaluate(ctx);
  assert.equal(entry.side, 'buy');
  assert.equal(entry.stopLossPct, 0.6);
  assert.equal(entry.takeProfitPct, 1.2);
  assert.deepEqual(macdBb.evaluate({ ...ctx, candles: reversal.slice(1) }), []);
  assert.deepEqual(macdBb.evaluate({ ...ctx, candles: reversal.map((_, i) => bar(i, 100 - i / 10)) }), []);
  const bearish = reversal.map((c, i) => bar(i, 200 - c.c));
  assert.deepEqual(macdBb.evaluate({ ...ctx, candles: bearish }), []);
  const pf = new PaperPortfolio();
  pf.open(entry, 100, 0.1);
  const positions = [...pf.positions.values()];
  assert.deepEqual(macdBb.evaluate({ ...ctx, positions }), []);
  assert.equal(macdBb.evaluate({ ...ctx, candles: bearish, positions })[0]?.side, 'sell');
});

test('only fresh, contiguous, closed candles can produce a signal', () => {
  const feed = { candles: [...reversal, bar(120, 200)], price: 200, source: 'binance' as const, lastFetch: 120 * minute + 1000 };
  assert.deepEqual(closedStrategyBars(feed, '1m', 120), reversal);
  assert.deepEqual(closedStrategyBars(feed, '1M', 120), []);
  assert.deepEqual(closedStrategyBars({ ...feed, candles: feed.candles.filter((c) => c.t !== 5 * minute) }, '1m', 120), []);
  assert.deepEqual(closedStrategyBars({ ...feed, lastFetch: 122 * minute }, '1m', 120), []);
});

test('managed sizing budgets fees and slippage and the wallet cannot overspend cash', () => {
  const intent: TradeIntent = { strategy: 'test', symbol, side: 'buy', reason: 'test', confidence: 1,
    stopLossPct: 2, takeProfitPct: 4, maxHoldMin: 100, management: { riskPct: 0.25, trailAfterPct: 2 } };
  const size = managedSize(intent, 10_000, 0.1, 10, 10_000);
  const pf = new PaperPortfolio();
  assert.ok(pf.open({ ...intent, sizeUsd: size }, 100, 0.1));
  const fill = pf.close('test', symbol, 98 * 0.999, 0.1, 'stop loss');
  assert.ok(Math.abs(fill!.pnlUsd! + 25) < 1e-9);
  assert.equal(managedSize(intent, 10_000, 0.1, 10, 500), 500);
  assert.equal(managedSize({ ...intent, stopLossPct: 0 }, 10_000, 0.1, 10, 500), 0);
  const small = new PaperPortfolio(100);
  assert.ok(small.open({ ...intent, sizeUsd: 100 }, 100, 0.1));
  assert.ok(small.cashUsd >= 0 && small.cashUsd < 1e-9);
});

test('replay buys at next open, charges both sides on a gap stop and includes the first drawdown', () => {
  const seen: number[] = [];
  const fixture: Strategy = { name: 'fixture', description: '', defaults: {}, closedBars: 1, evaluate: ({ price }) => {
    seen.push(price);
    return price === 100 ? [{ strategy: 'fixture', symbol, side: 'buy', reason: 'test',
      confidence: 1, sizeUsd: 300, stopLossPct: 4 }] : [];
  } };
  const candles = [bar(0, 100), bar(1, 130, 120), bar(2, 110, 110)];
  const row = replayOne(fixture, {}, symbol, candles, 0.2, 10, minute);
  assert.deepEqual(seen, [100, 130]);
  const exitUsd = 300 / (120 * 1.001) * 110 * 0.999;
  const fees = (300 + exitUsd) * 0.002;
  assert.equal(row.trades, 1);
  assert.equal(row.pnlUsd, +(exitUsd - 300 - fees).toFixed(2));
  assert.equal(row.feesUsd, +fees.toFixed(2));
  assert.equal(row.maxDdUsd, -row.pnlUsd);
  assert.ok(config.engine.startUsd > 300);
  assert.equal(replayOne(fixture, {}, symbol, [candles[0], candles[2]], 0.2, 10, minute).bars, 0);
  assert.equal(replayOne(fixture, {}, symbol, candles.slice(0, 1), 0.2, 10, minute).trades, 0);
});

test('indicator helpers reject invalid lookback parameters instead of producing NaN signals', async () => {
  const { sma, ema, rsi, bollinger, zscore, pctChange, macdHist } = await import('../src/engine/indicators.js');
  const xs = [1, 2, 3, 4, 5];
  for (const n of [0, -1, 1.5, NaN]) {
    assert.equal(sma(xs, n), null);
    assert.equal(ema(xs, n), null);
    assert.equal(rsi(xs, n), null);
    assert.equal(bollinger(xs, n), null);
    assert.equal(zscore(xs, n), null);
    assert.equal(pctChange(xs, n), null);
  }
  assert.equal(bollinger(xs, 2, 0), null);
  assert.equal(macdHist(xs, 0, 2, 1), null);
});


test('research runners reject non-fixed candle intervals before network fetches', async () => {
  await assert.rejects(runSweep('rsi_reversion', [symbol], 'bad-interval'), /fixed candle interval/);
  await assert.rejects(runStress([symbol], '1M'), /fixed candle interval/);
});

test('archive reports for different symbols and windows do not overwrite each other', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crypto-tracker-replay-'));
  const cwd = process.cwd();
  t.after(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  writeFileSync('first.csv', '60000,100,101,99,100,1\n120000,100,101,99,100,1\n');
  writeFileSync('next.csv', '180000,100,101,99,100,1\n240000,100,101,99,100,1\n');
  const first = await runBacktest([symbol], '1m', 'first.csv');
  const otherSymbol = await runBacktest(['ETHUSDT'], '1m', 'first.csv');
  const next = await runBacktest([symbol], '1m', 'next.csv');
  assert.equal(new Set([first.file, otherSymbol.file, next.file]).size, 3);
  assert.ok([first, otherSymbol, next].every(({ file }) => existsSync(file)));
});
