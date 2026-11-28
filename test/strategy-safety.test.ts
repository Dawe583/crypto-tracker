import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperPortfolio } from '../src/engine/portfolio.js';
import { RiskEngine } from '../src/engine/risk.js';
import { loadStrategies } from '../src/strategies/registry.js';
import { LIBRARY } from '../src/strategies/library.js';

const symbol = 'BTCUSDT';

test('strategy config ignores malformed roots and non-numeric parameter overrides', () => {
  assert.deepEqual(loadStrategies([] as never).filter(({ enabled }) => enabled), []);
  const rsi = loadStrategies({ rsi_reversion: { enabled: true, params: { oversold: 'bad', exitAt: 55, extra: NaN } as never } }).find(({ strategy }) => strategy.name === 'rsi_reversion')!;
  assert.equal(rsi.enabled, true);
  assert.equal(rsi.params.oversold, rsi.strategy.defaults.oversold);
  assert.equal(rsi.params.exitAt, 55);
  assert.equal('extra' in rsi.params, false);
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
  assert.equal(rsi([1, 1, 1, 1, 1], 2), null);
  assert.equal(rsi([1, 2, 3], 1), 100);
});
test('research runners reject non-fixed candle intervals before network fetches', async () => {
  const [{ runSweep }, { runStress }] = await Promise.all([import('../src/engine/sweep.js'), import('../src/engine/stress.js')]);
  await assert.rejects(runSweep('rsi_reversion', [symbol], 'bad-interval'), /fixed candle interval/);
  await assert.rejects(runStress([symbol], '1M'), /fixed candle interval/);
});
test('portfolio rejects malformed optional risk exits before they enter the ledger', () => {
  const pf = new PaperPortfolio(1000);
  const intent = { strategy: 'fixture', symbol: 'BTCUSDT', side: 'buy' as const, confidence: 1, sizeUsd: 100, reason: 'test' };
  assert.equal(pf.open({ ...intent, stopLossPct: -1 }, 100, 0), null);
  assert.equal(pf.open({ ...intent, stopLossPct: 100 }, 100, 0), null);
  assert.equal(pf.open({ ...intent, takeProfitPct: 0 }, 100, 0), null);
  assert.equal(pf.open({ ...intent, maxHoldMin: -5 }, 100, 0), null);
  assert.ok(pf.open({ ...intent, stopLossPct: 5, takeProfitPct: 10, maxHoldMin: 60 }, 100, 0));
});
test('invalid strategy lookback periods fall back to defaults', () => {
  const [emaStrategy] = loadStrategies({ ema_cross: { enabled: true, params: { fast: 0, slow: 21.5, sizeUsd: 300 } } })
    .filter(({ strategy }) => strategy.name === 'ema_cross');
  assert.equal(emaStrategy.params.fast, 9);
  assert.equal(emaStrategy.params.slow, 21);
  assert.equal(emaStrategy.params.sizeUsd, 300);
});

test('keltner squeeze requires an actual squeeze release transition', () => {
  const strategy = LIBRARY.find(({ name }) => name === 'keltner_squeeze')!;
  const candle = (i: number, c: number) => ({ t: i * 60_000, o: c, h: c + 0.1, l: c - 0.1, c, v: 1 });
  const trend = Array.from({ length: 70 }, (_, i) => candle(i, 100 + (i >= 55 ? i - 54 : 0)));
  const ctx = { symbol, candles: trend, price: trend.at(-1)!.c, positions: [], signals: { whaleBuys: 0, newPools: 0, goldSpread: {} }, params: strategy.defaults };
  assert.deepEqual(strategy.evaluate(ctx), []);
  const release = Array.from({ length: 70 }, (_, i) => candle(i, i === 69 ? 105 : 100));
  assert.equal(strategy.evaluate({ ...ctx, candles: release, price: 105 })[0]?.side, 'buy');
});

test('portfolio checkpoint restore rejects impossible positions fail-closed', () => {
  const source = new PaperPortfolio(1000);
  const intent = { strategy: 'fixture', symbol, side: 'buy' as const, confidence: 1, sizeUsd: 100, reason: 'test', stopLossPct: 5 };
  assert.ok(source.open(intent, 100, 0.1, 1000));
  const checkpoint = source.checkpoint();
  const position = checkpoint.positions[0];
  assert.doesNotThrow(() => new PaperPortfolio(1000).restoreCheckpoint(checkpoint));
  for (const positions of [
    [{ ...position, qty: -1 }],
    [{ ...position, entryPrice: 0 }],
    [{ ...position, sizeUsd: 0 }],
    [{ ...position, stopLossPct: 0 }],
    [position, { ...position, id: 'duplicate' }],
  ]) {
    assert.throws(() => new PaperPortfolio(1000).restoreCheckpoint({ ...checkpoint, positions }), /invalid paper portfolio ledger checkpoint/);
  }
});

test('risk checkpoint restore rejects malformed baselines and cooldowns fail-closed', () => {
  const risk = new RiskEngine({ maxPositionUsd: 500, maxTotalUsd: 1000, maxOpenPositions: 8, dailyLossPct: 5, minConfidence: 0.5, cooldownMin: 60, startEquityUsd: 10_000 }, 0, false);
  const checkpoint = risk.checkpoint();
  assert.doesNotThrow(() => risk.restoreCheckpoint(checkpoint));
  for (const malformed of [
    { ...checkpoint, dayStart: '' },
    { ...checkpoint, dayStartEquity: -1 },
    { ...checkpoint, losses: null },
    { ...checkpoint, losses: [['fixture', { n: -1, until: 0 }]] },
    { ...checkpoint, losses: [['fixture', { n: 1, until: NaN }]] },
  ]) {
    assert.throws(() => risk.restoreCheckpoint(malformed as never), /invalid paper risk ledger checkpoint/);
  }
});
