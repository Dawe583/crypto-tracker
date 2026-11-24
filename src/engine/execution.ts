import type { Position, Side, TradeIntent } from './types.js';

export const MANAGED_SLIPPAGE_BPS = 3;

export function slippedPrice(price: number, side: Side, bps: number) {
  return price * (1 + (side === 'buy' ? 1 : -1) * bps / 10_000);
}

export function managedSize(intent: TradeIntent, equity: number, feePct: number, slipBps: number, notionalCap: number) {
  if (!intent.management) return 0;
  const { riskPct, trailAfterPct } = intent.management;
  const { stopLossPct = 0, takeProfitPct = 0, maxHoldMin = 0 } = intent;
  if (![riskPct, trailAfterPct, stopLossPct, takeProfitPct, maxHoldMin, equity, notionalCap].every((n) => Number.isFinite(n) && n > 0)
    || stopLossPct >= 100 || riskPct > 100 || !Number.isFinite(feePct) || feePct < 0
    || !Number.isFinite(slipBps) || slipBps < 0 || slipBps >= 10_000) return 0;
  // Jesse's risk-to-quantity formula, expressed in notional and including adverse stop slippage.
  const stopFillRatio = slippedPrice(1 - stopLossPct / 100, 'sell', slipBps);
  const lossPerDollar = (1 - stopFillRatio) + feePct / 100 * (1 + stopFillRatio);
  return Math.min(notionalCap, equity * riskPct / 100 / lossPerDollar);
}

export function positionExit(p: Position, mark: number, now: number): string | null {
  const change = (mark / p.entryPrice - 1) * 100;
  const initialStop = p.stopLossPct === null ? 0 : p.entryPrice * (1 - p.stopLossPct / 100);
  const trail = p.trailing;
  if (trail) trail.peak = Math.max(trail.peak, mark);
  const trailingStop = trail && p.stopLossPct !== null && trail.peak >= p.entryPrice * (1 + trail.afterPct / 100)
    ? trail.peak * (1 - p.stopLossPct / 100) : 0;
  if (mark <= Math.max(initialStop, trailingStop))
    return trailingStop > initialStop ? 'trailing stop' : `stop loss ${change.toFixed(1)}%`;
  if (p.takeProfitPct !== null && mark >= p.entryPrice * (1 + p.takeProfitPct / 100)) return `take profit +${change.toFixed(1)}%`;
  return p.maxHoldMin !== null && now - p.entryTs >= p.maxHoldMin * 60_000 ? 'max hold reached' : null;
}
