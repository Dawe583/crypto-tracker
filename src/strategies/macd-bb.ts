// Adapted from Hummingbot's macd_bb_v1 controller (Apache-2.0).
// Modified for closed candles, long-only spot, and this simulator's exit rules.
import { atr, bollinger, closes, macd } from '../engine/indicators.js';
import type { Strategy } from '../engine/types.js';

const NAME = 'macd_bb_v1';
const WARMUP = 120;

export const macdBb: Strategy = {
  name: NAME,
  description: 'Hummingbot MACD/Bollinger rebound with volatility-sized paper trades',
  closedBars: WARMUP,
  defaults: { riskPct: 0.25, atrMult: 2.5, minStopPct: 0.6, maxStopPct: 3, rewardR: 2, maxHoldMin: 180 },
  evaluate({ symbol, candles, positions, params }) {
    if (candles.length < WARMUP) return [];
    const xs = closes(candles);
    const close = xs[xs.length - 1];
    const bands = bollinger(xs, 100, 2);
    const momentum = macd(xs, 21, 42, 9);
    if (!bands || bands.up === bands.lo || !momentum) return [];

    const own = positions.some((p) => p.strategy === NAME && p.symbol === symbol);
    if (own && close > bands.up && momentum.histogram < 0 && momentum.line > 0)
      return [{ strategy: NAME, symbol, side: 'sell', confidence: 1, reason: 'Upper Bollinger band and bearish MACD reversal' }];

    if (positions.some((p) => p.symbol === symbol) || close >= bands.lo || momentum.histogram <= 0 || momentum.line >= 0) return [];
    const range = atr(candles);
    if (range === null || range <= 0) return [];
    const stopLossPct = Math.max(params.minStopPct, params.atrMult * range / close * 100);
    if (!(stopLossPct <= params.maxStopPct)) return [];
    return [{
      strategy: NAME, symbol, side: 'buy', confidence: 1, reason: 'Lower Bollinger band and bullish MACD reversal',
      stopLossPct, takeProfitPct: stopLossPct * params.rewardR, maxHoldMin: params.maxHoldMin,
      management: { riskPct: params.riskPct, trailAfterPct: stopLossPct },
    }];
  },
};
