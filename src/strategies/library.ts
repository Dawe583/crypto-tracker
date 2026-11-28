// Strategy library: pure evaluators, each (ctx) -> TradeIntent[].
// Entries are typed narrow calls; sizing/risk/exits live in the engine.
import type { Strategy } from '../engine/types.js';
import { closes, highs, lows, vols, sma, ema, rsi, atr, macdHist, bollinger, zscore, pctChange } from '../engine/indicators.js';
import { macdBb } from './macd-bb.js';

const buy = (strategy: string, symbol: string, confidence: number, reason: string, extra = {}): any =>
  ({ strategy, symbol, side: 'buy', confidence, reason, ...extra });
const sell = (strategy: string, symbol: string, confidence: number, reason: string): any =>
  ({ strategy, symbol, side: 'sell', confidence, reason });

export const LIBRARY: Strategy[] = [
  macdBb,
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
      const whaleBuys = ctx.signals.whaleSymbols?.[ctx.symbol] ?? 0;
      if (ctx.params.minSignals >= 1 && whaleBuys >= ctx.params.minSignals && !has)
        return [buy('whale_follow', ctx.symbol, 0.7, `${whaleBuys} whale buy signal(s) for ${ctx.symbol}`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
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
  {
    name: 'donchian',
    description: 'N-bar channel breakout, exit on midline cross',
    defaults: { n: 30, sizeUsd: 250, stopLossPct: 4, takeProfitPct: 8, maxHoldMin: 720 },
    evaluate(ctx) {
      const hs = highs(ctx.candles), ls = lows(ctx.candles), n = ctx.params.n;
      if (hs.length < n + 2) return [];
      const hi = Math.max(...hs.slice(-n - 1, -1)), lo = Math.min(...ls.slice(-n - 1, -1));
      const mid = (hi + lo) / 2, c = ctx.candles[ctx.candles.length - 1].c;
      const has = ctx.positions.some((p) => p.strategy === 'donchian' && p.symbol === ctx.symbol);
      if (c > hi && !has)
        return [buy('donchian', ctx.symbol, 0.65, `close above ${n}bar channel ${hi.toFixed(2)}`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (c < mid && has) return [sell('donchian', ctx.symbol, 0.6, 'midline cross')];
      return [];
    },
  },
  {
    name: 'vwap_reversion',
    description: 'Fade stretch below rolling VWAP, exit at VWAP',
    defaults: { n: 60, devPct: 1.2, sizeUsd: 250, stopLossPct: 4, takeProfitPct: 5, maxHoldMin: 480 },
    evaluate(ctx) {
      const cs = ctx.candles.slice(-ctx.params.n);
      if (cs.length < 20) return [];
      let pv = 0, v = 0;
      for (const c of cs) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; v += c.v; }
      if (!v) return [];
      const vwap = pv / v, last = ctx.candles[ctx.candles.length - 1].c;
      const dev = ((last - vwap) / vwap) * 100;
      const has = ctx.positions.some((p) => p.strategy === 'vwap_reversion' && p.symbol === ctx.symbol);
      if (dev <= -ctx.params.devPct && !has)
        return [buy('vwap_reversion', ctx.symbol, 0.62, `${dev.toFixed(2)}% under VWAP`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (dev >= -0.1 && has) return [sell('vwap_reversion', ctx.symbol, 0.6, `reverted to VWAP (${dev.toFixed(2)}%)`)];
      return [];
    },
  },
  {
    name: 'stoch_cross',
    description: 'Stochastic %K/%D bullish cross below oversold zone',
    defaults: { k: 14, d: 3, zone: 20, sizeUsd: 250, stopLossPct: 4, takeProfitPct: 6, maxHoldMin: 480 },
    evaluate(ctx) {
      const cs = ctx.candles, k = ctx.params.k, d = ctx.params.d;
      if (cs.length < k + d + 2) return [];
      const kline = (arr: typeof cs) => {
        const w = arr.slice(-k);
        const lo = Math.min(...w.map((c) => c.l)), hi = Math.max(...w.map((c) => c.h));
        return ((arr[arr.length - 1].c - lo) / (hi - lo || 1e-9)) * 100;
      };
      const ks = Array.from({ length: d + 1 }, (_, i) => kline(cs.slice(0, cs.length - i)));
      const kNow = ks[0], dNow = ks.slice(0, d).reduce((a, b) => a + b, 0) / d;
      const kPrev = ks[1], dPrev = ks.slice(1, d + 1).reduce((a, b) => a + b, 0) / d;
      const has = ctx.positions.some((p) => p.strategy === 'stoch_cross' && p.symbol === ctx.symbol);
      if (kPrev <= dPrev && kNow > dNow && kNow < ctx.params.zone && !has)
        return [buy('stoch_cross', ctx.symbol, 0.62, `stoch cross ${kNow.toFixed(0)} under ${ctx.params.zone}`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (kNow > 80 && has) return [sell('stoch_cross', ctx.symbol, 0.6, `stoch ${kNow.toFixed(0)} overbought`)];
      return [];
    },
  },
  {
    name: 'keltner_squeeze',
    description: 'Bollinger-inside-Keltner squeeze -> momentum expansion',
    defaults: { n: 20, kcMult: 1.5, sizeUsd: 250, stopLossPct: 3.5, takeProfitPct: 7, maxHoldMin: 480 },
    evaluate(ctx) {
      const xs = closes(ctx.candles), n = ctx.params.n;
      if (xs.length < n + 2) return [];
      const b = bollinger(xs, n, 2);
      const mid = ema(xs, n), a = atr(ctx.candles, 10);
      const h = macdHist(xs);
      if (!b || mid === null || a === null || h === null) return [];
      const kc = ctx.params.kcMult * a;
      const squeeze = (b.up - b.lo) < 2 * kc;            // bollinger inside keltner
      const c = xs[xs.length - 1];
      const has = ctx.positions.some((p) => p.strategy === 'keltner_squeeze' && p.symbol === ctx.symbol);
      if (!squeeze && h > 0 && c > mid && !has)
        return [buy('keltner_squeeze', ctx.symbol, 0.6, `squeeze fired, momentum up`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (h < 0 && has) return [sell('keltner_squeeze', ctx.symbol, 0.6, 'momentum faded')];
      return [];
    },
  },
  {
    name: 'obv_drift',
    description: 'On-balance-volume rising while price drifts down (accumulation)',
    defaults: { n: 20, sizeUsd: 200, stopLossPct: 5, takeProfitPct: 8, maxHoldMin: 1440 },
    evaluate(ctx) {
      const cs = ctx.candles, n = ctx.params.n;
      if (cs.length < n + 2) return [];
      const w = cs.slice(-n - 1);
      let obvSlope = 0;
      for (let i = 1; i < w.length; i++) obvSlope += Math.sign(w[i].c - w[i - 1].c) * w[i].v;
      const priceChg = ((w[w.length - 1].c - w[0].c) / w[0].c) * 100;
      const has = ctx.positions.some((p) => p.strategy === 'obv_drift' && p.symbol === ctx.symbol);
      if (obvSlope > 0 && priceChg < 0.2 && !has)
        return [buy('obv_drift', ctx.symbol, 0.58, `OBV +, price ${priceChg.toFixed(2)}%`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (obvSlope < 0 && has) return [sell('obv_drift', ctx.symbol, 0.6, 'OBV turned down')];
      return [];
    },
  },
  {
    name: 'roc_momentum',
    description: 'Rate-of-change momentum burst entry, exit on ROC flip',
    defaults: { n: 10, entry: 1.2, sizeUsd: 200, stopLossPct: 3, takeProfitPct: 6, maxHoldMin: 360 },
    evaluate(ctx) {
      const r = pctChange(closes(ctx.candles), ctx.params.n);
      if (r === null) return [];
      const has = ctx.positions.some((p) => p.strategy === 'roc_momentum' && p.symbol === ctx.symbol);
      if (r > ctx.params.entry && !has)
        return [buy('roc_momentum', ctx.symbol, 0.6, `ROC${ctx.params.n} +${r.toFixed(2)}%`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      if (r < 0 && has) return [sell('roc_momentum', ctx.symbol, 0.6, `ROC flipped ${r.toFixed(2)}%`)];
      return [];
    },
  },
  {
    name: 'engulfing',
    description: 'Bullish engulfing candle on elevated volume',
    defaults: { volMult: 1.3, sizeUsd: 200, stopLossPct: 3, takeProfitPct: 5, maxHoldMin: 240 },
    evaluate(ctx) {
      const cs = ctx.candles;
      if (cs.length < 22) return [];
      const [p, l] = cs.slice(-2);
      const vAvg = sma(vols(cs.slice(0, -1)), 20) ?? 0;
      const engulf = p.c < p.o && l.c > l.o && l.c >= p.o && l.o <= p.c;
      const has = ctx.positions.some((x) => x.strategy === 'engulfing' && x.symbol === ctx.symbol);
      if (engulf && l.v > vAvg * ctx.params.volMult && !has)
        return [buy('engulfing', ctx.symbol, 0.58, `bullish engulfing on ${(l.v / (vAvg || 1)).toFixed(1)}x vol`, { sizeUsd: ctx.params.sizeUsd, stopLossPct: ctx.params.stopLossPct, takeProfitPct: ctx.params.takeProfitPct, maxHoldMin: ctx.params.maxHoldMin })];
      return [];
    },
  },
];
