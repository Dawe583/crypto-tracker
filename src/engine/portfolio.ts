// Paper portfolio: cash, positions, realized/unrealized PnL, fee accounting.
import type { Fill, Position, TradeIntent } from './types.js';

export class PaperPortfolio {
  cashUsd: number;
  positions = new Map<string, Position>(); // key: strategy|symbol
  realizedUsd = 0;
  feesUsd = 0;
  tradesClosed = 0;
  wins = 0;
  private seq = 0;

  constructor(startUsd = 10_000) {
    this.cashUsd = startUsd;
  }

  canOpen(i: TradeIntent): boolean {
    return !this.positions.has(this.key(i));
  }

  open(i: TradeIntent, price: number, feePct: number): Fill | null {
    const usd = Math.min(i.sizeUsd ?? 500, this.cashUsd);
    if (usd < 5 || !this.canOpen(i)) return null;
    const qty = usd / price;
    const fee = usd * (feePct / 100);
    this.cashUsd -= usd + fee;
    this.feesUsd += fee;
    const pos: Position = {
      id: `p${++this.seq}`,
      strategy: i.strategy,
      symbol: i.symbol,
      qty,
      entryPrice: price,
      entryTs: Date.now(),
      sizeUsd: usd,
      stopLossPct: i.stopLossPct ?? null,
      takeProfitPct: i.takeProfitPct ?? null,
      maxHoldMin: i.maxHoldMin ?? null,
    };
    this.positions.set(this.key(i), pos);
    return { id: pos.id, strategy: i.strategy, symbol: i.symbol, side: 'buy', qty, price, usd, feeUsd: fee, reason: i.reason, ts: Date.now() };
  }

  close(strategy: string, symbol: string, price: number, feePct: number, reason: string): Fill | null {
    const key = `${strategy}|${symbol}`;
    const pos = this.positions.get(key);
    if (!pos) return null;
    const usd = pos.qty * price;
    const fee = usd * (feePct / 100);
    this.cashUsd += usd - fee;
    this.feesUsd += fee;
    const pnl = usd - fee - pos.sizeUsd;
    this.realizedUsd += pnl;
    this.tradesClosed += 1;
    if (pnl > 0) this.wins += 1;
    this.positions.delete(key);
    return { id: pos.id, strategy, symbol, side: 'sell', qty: pos.qty, price, usd, feeUsd: fee, reason, ts: Date.now(), pnlUsd: pnl };
  }

  equity(prices: Map<string, number>): number {
    let eq = this.cashUsd;
    for (const p of this.positions.values()) eq += p.qty * (prices.get(p.symbol) ?? p.entryPrice);
    return eq;
  }

  unrealized(prices: Map<string, number>): number {
    let u = 0;
    for (const p of this.positions.values()) u += p.qty * (prices.get(p.symbol) ?? p.entryPrice) - p.sizeUsd;
    return u;
  }

  private key(i: { strategy: string; symbol: string }) {
    return `${i.strategy}|${i.symbol}`;
  }
}
