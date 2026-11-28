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
