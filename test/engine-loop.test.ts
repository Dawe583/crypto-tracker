import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPaperEngine } from '../src/engine/loop.js';
import type { Candle, Strategy } from '../src/engine/types.js';
import type { Feed } from '../src/engine/market.js';

const minute = 60_000;

test('strategies evaluate each completed candle once, not the forming candle', async () => {
  const firstOpen = Date.UTC(2026, 10, 24, 12, 0);
  const candle = (index: number, close = 100): Candle => ({
    t: firstOpen + index * minute, o: close, h: close + 1, l: close - 1, c: close, v: 10,
  });
  const completed = Array.from({ length: 70 }, (_, i) => candle(i));
  const forming = candle(70, 200);
  const feed: Feed = {
    candles: [...completed, forming],
    price: forming.c,
    source: 'binance',
    lastFetch: forming.t + 30_000,
    requestedAt: forming.t + 30_000,
  };
  const seen: [string, number][] = [];
  const fixture: Strategy = {
    name: 'fixture', description: '', defaults: {}, evaluate: ({ symbol, candles }) => {
      seen.push([symbol, candles[candles.length - 1]?.t ?? 0]);
      return [];
    },
  };
  const state = { snapshot: null, decisions: [], halted: false };
  const engine = createPaperEngine({
    state,
    append: () => {},
    refresh: async () => feed,
    signals: () => ({ whaleBuys: 0, newPools: 0, goldSpread: {} }),
    strategies: [{ strategy: fixture, params: {}, enabled: true }],
  });

  await engine.cycle();
  assert.equal(seen.length, 6);
  assert.ok(seen.every(([, bar]) => bar === completed[completed.length - 1].t));
  await engine.cycle();
  assert.equal(seen.length, 6);
});

test('a changed external signal reevaluates the same closed bar', async () => {
  const firstOpen = Date.UTC(2026, 10, 24, 12, 0);
  const candle = (index: number): Candle => ({ t: firstOpen + index * minute, o: 100, h: 101, l: 99, c: 100, v: 10 });
  const completed = Array.from({ length: 70 }, (_, i) => candle(i));
  const forming = candle(70);
  const feed: Feed = { candles: [...completed, forming], price: 100, source: 'binance', lastFetch: forming.t + 30_000, requestedAt: forming.t + 30_000 };
  let whaleBuys = 0;
  let evaluations = 0;
  const fixture: Strategy = { name: 'signal-fixture', description: '', defaults: {}, evaluate: () => { evaluations += 1; return []; } };
  const state = { snapshot: null, decisions: [], halted: false };
  const engine = createPaperEngine({
    state,
    append: () => {},
    refresh: async () => feed,
    signals: () => ({ whaleBuys, newPools: 0, goldSpread: {} }),
    strategies: [{ strategy: fixture, params: {}, enabled: true }],
  });
  await engine.cycle();
  await engine.cycle();
  const initial = evaluations;
  whaleBuys = 1;
  await engine.cycle();
  assert.equal(evaluations, initial * 2);
});

test('engine checkpoints reject malformed stats and signal cursors', () => {
  const state = { snapshot: null, decisions: [], halted: false };
  const engine = createPaperEngine({
    state,
    append: () => {},
    refresh: async () => null,
    signals: () => ({ whaleBuys: 0, newPools: 0, goldSpread: {} }),
    strategies: [],
  });
  const checkpoint = engine.checkpoint();
  assert.doesNotThrow(() => engine.restore(checkpoint));
  for (const malformed of [
    { ...checkpoint, stats: [['fixture', { pnl: NaN, trades: 0, wins: 0 }]] },
    { ...checkpoint, stats: [['fixture', { pnl: 0, trades: 1, wins: 2 }]] },
    { ...checkpoint, lastSignalBars: [['fixture|BTCUSDT', NaN]] },
    { ...checkpoint, signalFingerprints: [['fixture|BTCUSDT', '']] },
  ]) {
    assert.throws(() => engine.restore(malformed as never), /invalid paper engine ledger checkpoint/);
  }
});

test('a protective stop cannot re-enter the same market in the same cycle', async () => {
  const firstOpen = Date.UTC(2026, 10, 24, 12, 0);
  const candle = (index: number): Candle => ({ t: firstOpen + index * minute, o: 100, h: 101, l: 99, c: 100, v: 10 });
  const completed = Array.from({ length: 70 }, (_, i) => candle(i));
  const forming = { ...candle(70), c: 94, l: 93 };
  const feed: Feed = { candles: [...completed, forming], price: 94, source: 'binance', lastFetch: forming.t + 30_000, requestedAt: forming.t + 30_000 };
  const fixture: Strategy = {
    name: 'stop-fixture', description: '', defaults: {}, evaluate: ({ symbol }) => [{
      strategy: 'stop-fixture', symbol, side: 'buy', confidence: 1, reason: 'always re-enter', sizeUsd: 100,
    }],
  };
  const state = { snapshot: null, decisions: [], halted: false };
  const engine = createPaperEngine({
    state,
    append: () => {},
    refresh: async () => feed,
    signals: () => ({ whaleBuys: 0, newPools: 0, goldSpread: {} }),
    strategies: [{ strategy: fixture, params: {}, enabled: true }],
  });
  engine.portfolio.open({ strategy: 'stop-fixture', symbol: 'BTCUSDT', side: 'buy', confidence: 1, reason: 'seed', sizeUsd: 100, stopLossPct: 5 }, 100, 0.1, forming.t - minute);
  await engine.cycle();
  assert.equal(engine.portfolio.positions.has('stop-fixture|BTCUSDT'), false);
  assert.equal(engine.portfolio.tradesClosed, 1);
});
