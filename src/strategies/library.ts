// Strategy library: 12 pure evaluators, each (ctx) -> TradeIntent[].
// Entries are typed narrow calls; sizing/risk/exits live in the engine.
import type { Strategy } from '../engine/types.js';
import { closes, vols, sma, ema, rsi, atr, macdHist, bollinger, zscore, pctChange } from '../engine/indicators.js';

const buy = (strategy: string, symbol: string, confidence: number, reason: string, extra = {}): any =>
  ({ strategy, symbol, side: 'buy', confidence, reason, ...extra });
const sell = (strategy: string, symbol: string, confidence: number, reason: string): any =>
  ({ strategy, symbol, side: 'sell', confidence, reason });

export const LIBRARY: Strategy[] = [
  {
    name: 'ema_cross',
    description: 'Fast/slow EMA crossover trend entries',
    defaults: { fast: 9, slow: 21, sizeUsd: 300, stopLossPct: 4, takeProfitPct: 8, maxHoldMin: 720 },
    evaluate(ctx) {
      const xs = closes(ctx.candles);
      const f = ctx.params.fast, s = ctx.params.slow;
      if (xs.length < s + 2) return [];
      const ef0 = ema(xs.slice(0, -1), f), es0 = ema(xs.slice(0, -1), s);
      const ef1 = ema(xs, f), es1 = ema(xs, s);
      if (ef0 === null || es0 === null || ef1 === null || es1 === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'ema_cross' && p.symbol === ctx.symbol);
      if (ef0 <= es0 && ef1 > es1 && !has)
        return [buy('ema_cross', ctx.symbol, 0.65, `EMA${f} crossed above EMA${s}`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (ef0 >= es0 && ef1 < es1 && has) return [sell('ema_cross', ctx.symbol, 0.7, `EMA${f} crossed below EMA${s}`)];
      return [];
    },
  },
  {
    name: 'rsi_reversion',
    description: 'Buy RSI oversold, exit on midline recover',
    defaults: { n: 14, oversold: 30, exitAt: 50, sizeUsd: 250, stopLossPct: 5, takeProfitPct: 7, maxHoldMin: 480 },
    evaluate(ctx) {
      const r = rsi(closes(ctx.candles), ctx.params.n);
      if (r === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'rsi_reversion' && p.symbol === ctx.symbol);
      if (r < ctx.params.oversold && !has)
        return [buy('rsi_reversion', ctx.symbol, 0.6 + (ctx.params.oversold - r) / 100, `RSI ${r.toFixed(1)} oversold`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (r > ctx.params.exitAt && has) return [sell('rsi_reversion', ctx.symbol, 0.6, `RSI ${r.toFixed(1)} recovered` )];
      return [];
    },
  },
  {
    name: 'bollinger_reversion',
    description: 'Fade lower-band touches back to the midline',
    defaults: { n: 20, mult: 2, sizeUsd: 250, stopLossPct: 5, takeProfitPct: 6, maxHoldMin: 360 },
    evaluate(ctx) {
      const b = bollinger(closes(ctx.candles), ctx.params.n, ctx.params.mult);
      if (!b) return [];
      const c = ctx.candles[ctx.candles.length - 1];
      const has = ctx.positions.some((p) => p.strategy === 'bollinger_reversion' && p.symbol === ctx.symbol);
      if (c.l <= b.lo && c.c > b.lo && !has)
        return [buy('bollinger_reversion', ctx.symbol, 0.62, `lower band touched and reclaimed`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (c.c >= b.mid && has) return [sell('bollinger_reversion', ctx.symbol, 0.6, 'midline reached')];
      return [];
    },
  },
  {
    name: 'breakout',
    description: 'N-bar high break with volume confirmation',
    defaults: { n: 40, volMult: 1.5, sizeUsd: 300, stopLossPct: 3.5, takeProfitPct: 9, maxHoldMin: 720 },
    evaluate(ctx) {
      const cs = ctx.candles, n = ctx.params.n;
      if (cs.length < n + 2) return [];
      const window = cs.slice(-n - 1, -1);
      const hi = Math.max(...window.map((c) => c.h));
      const vAvg = sma(vols(cs.slice(0, -1)), n) ?? 0;
      const last = cs[cs.length - 1];
      const has = ctx.positions.some((p) => p.strategy === 'breakout' && p.symbol === ctx.symbol);
      if (last.c > hi && last.v > vAvg * ctx.params.volMult && !has)
        return [buy('breakout', ctx.symbol, 0.7, `broke ${n}bar high ${hi.toFixed(2)} on ${(last.v / (vAvg || 1)).toFixed(1)}x vol`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      return [];
    },
  },
  {
    name: 'macd_momentum',
    description: 'MACD histogram zero-cross momentum',
    defaults: { sizeUsd: 250, stopLossPct: 4, takeProfitPct: 8, maxHoldMin: 720 },
    evaluate(ctx) {
      const xs = closes(ctx.candles);
      if (xs.length < 40) return [];
      const h1 = macdHist(xs), h0 = macdHist(xs.slice(0, -1));
      if (h1 === null || h0 === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'macd_momentum' && p.symbol === ctx.symbol);
      if (h0 <= 0 && h1 > 0 && !has)
        return [buy('macd_momentum', ctx.symbol, 0.6, `MACD hist flipped + (${h1.toFixed(4)})`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (h0 >= 0 && h1 < 0 && has) return [sell('macd_momentum', ctx.symbol, 0.65, 'MACD hist flipped -')];
      return [];
    },
  },
  {
    name: 'vol_spike',
    description: 'Abnormal volume bar -> momentum continuation',
    defaults: { n: 30, mult: 3, sizeUsd: 200, stopLossPct: 3, takeProfitPct: 6, maxHoldMin: 240 },
    evaluate(ctx) {
      const cs = ctx.candles, n = ctx.params.n;
      if (cs.length < n + 1) return [];
      const vAvg = sma(vols(cs.slice(0, -1)), n) ?? 0;
      const last = cs[cs.length - 1];
      const body = (last.c - last.o) / last.o;
      const has = ctx.positions.some((p) => p.strategy === 'vol_spike' && p.symbol === ctx.symbol);
      if (vAvg > 0 && last.v > vAvg * ctx.params.mult && body > 0.003 && !has)
        return [buy('vol_spike', ctx.symbol, 0.66, `vol ${(last.v / vAvg).toFixed(1)}x avg, +${(body * 100).toFixed(1)}% bar`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      return [];
    },
  },
  {
    name: 'atr_trend',
    description: 'EMA trend + ATR-scaled stops (trend follower)',
    defaults: { trendN: 50, atrMult: 2.5, sizeUsd: 300, takeProfitPct: 12, maxHoldMin: 1440 },
    evaluate(ctx) {
      const xs = closes(ctx.candles), n = ctx.params.trendN;
      if (xs.length < n + 5) return [];
      const e = ema(xs, n), a = atr(ctx.candles);
      if (e === null || a === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'atr_trend' && p.symbol === ctx.symbol);
      const above = ctx.price > e;
      if (above && !has)
        return [buy('atr_trend', ctx.symbol, 0.62, `price above EMA${n}, ATR stop ${(a / ctx.price * 100).toFixed(1)}%`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: (a / ctx.price) * 100 * ctx.params.atrMult, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (!above && has) return [sell('atr_trend', ctx.symbol, 0.65, `price below EMA${n}`)];
      return [];
    },
  },
  {
    name: 'grid',
    description: 'Range harvester: buy grid steps below mid, sell at mid',
    defaults: { n: 30, stepPct: 1.5, sizeUsd: 200, maxHoldMin: 2880 },
    evaluate(ctx) {
      const xs = closes(ctx.candles), n = ctx.params.n;
      const mid = sma(xs, n);
      if (mid === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'grid' && p.symbol === ctx.symbol);
      const dev = (ctx.price - mid) / mid * 100;
      if (dev <= -ctx.params.stepPct && !has)
        return [buy('grid', ctx.symbol, 0.55, `${dev.toFixed(1)}% below ${n}bar mid`, { sizeUsd: ctx.params.sizeUsd, takeProfitPct: ctx.params.stepPct, stopLossPct: ctx.params.stepPct * 3, maxHoldMin: ctx.params.maxHoldMin })];
      if (dev >= 0 && has) return [sell('grid', ctx.symbol, 0.55, 'price at/above mid')];
      return [];
    },
  },
  {
    name: 'dca',
    description: 'Baseline: accumulate every N minutes on red bars',
    defaults: { intervalMin: 60, sizeUsd: 150, takeProfitPct: 10, stopLossPct: 15, maxHoldMin: 10080 },
    evaluate(ctx) {
      const last = ctx.candles[ctx.candles.length - 1];
      const has = ctx.positions.some((p) => p.strategy === 'dca' && p.symbol === ctx.symbol);
      const mins = (Date.now() - last.t) / 60000;
      if (last.c < last.o && mins < ctx.params.intervalMin && !has)
        return [buy('dca', ctx.symbol, 0.5, 'scheduled accumulation on red bar', { sizeUsd: ctx.params.sizeUsd, takeProfitPct: ctx.params.takeProfitPct, stopLossPct: ctx.params.stopLossPct, maxHoldMin: ctx.params.maxHoldMin })];
      return [];
    },
  },
  {
    name: 'zscore_reversion',
    description: 'Price z-score mean reversion',
    defaults: { n: 50, entryZ: -2, exitZ: 0, sizeUsd: 250, stopLossPct: 6, takeProfitPct: 7, maxHoldMin: 720 },
    evaluate(ctx) {
      const z = zscore(closes(ctx.candles), ctx.params.n);
      if (z === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'zscore_reversion' && p.symbol === ctx.symbol);
      if (z < ctx.params.entryZ && !has)
        return [buy('zscore_reversion', ctx.symbol, Math.min(0.85, 0.55 + Math.abs(z) / 10), `z=${z.toFixed(2)}`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (z > ctx.params.exitZ && has) return [sell('zscore_reversion', ctx.symbol, 0.6, `z=${z.toFixed(2)}`)];
      return [];
    },
  },
  {
    name: 'whale_follow',
    description: 'Entry when crypto-tracker logs a watched-whale buy (its unique edge)',
    defaults: { minSignals: 1, sizeUsd: 400, stopLossPct: 5, takeProfitPct: 12, maxHoldMin: 1440 },
    evaluate(ctx) {
      const has = ctx.positions.some((p) => p.strategy === 'whale_follow' && p.symbol === ctx.symbol);
      if (ctx.signals.whaleBuys >= ctx.params.minSignals && !has)
        return [buy('whale_follow', ctx.symbol, 0.7, `${ctx.signals.whaleBuys} whale buy signal(s) in tracker`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      return [];
    },
  },
  {
    name: 'gold_spread',
    description: 'Trade gold-RWA premium/discount direction from the gold monitor',
    defaults: { minSpreadPct: 1.0, sizeUsd: 200, stopLossPct: 4, takeProfitPct: 5, maxHoldMin: 1440 },
    evaluate(ctx) {
      const dev = ctx.signals.goldSpread[ctx.symbol];
      if (dev === undefined) return [];
      const has = ctx.positions.some((p) => p.strategy === 'gold_spread' && p.symbol === ctx.symbol);
      if (dev <= -ctx.params.minSpreadPct && !has)
        return [buy('gold_spread', ctx.symbol, 0.6, `DEX discount ${dev.toFixed(2)}% vs spot`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (dev >= -0.2 && has) return [sell('gold_spread', ctx.symbol, 0.6, `spread normalized ${dev.toFixed(2)}%`)];
      return [];
    },
  },
];
