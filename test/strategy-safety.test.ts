import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperPortfolio } from '../src/engine/portfolio.js';
import { loadStrategies } from '../src/strategies/registry.js';

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
