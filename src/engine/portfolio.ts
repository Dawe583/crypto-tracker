// Paper portfolio: cash, positions, realized/unrealized PnL, fee accounting.
import type { Fill, Position, TradeIntent } from './types.js';

export interface PaperPortfolioCheckpoint {
  cashUsd: number;
  positions: Position[];
  realizedUsd: number;
  feesUsd: number;
  tradesClosed: number;
  wins: number;
  seq: number;
}

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

  checkpoint(): PaperPortfolioCheckpoint {
    return {
      cashUsd: this.cashUsd, positions: [...this.positions.values()],
      realizedUsd: this.realizedUsd, feesUsd: this.feesUsd,
      tradesClosed: this.tradesClosed, wins: this.wins, seq: this.seq,
    };
  }

  restoreCheckpoint(c: PaperPortfolioCheckpoint) {
    if (Array.isArray(c?.positions)) for (const p of c.positions) {
      p.stopLossPct ??= null;
      p.takeProfitPct ??= null;
      p.maxHoldMin ??= null;
    }
    const validOptional = (value: number | null | undefined, allowHundred = false) =>
      value == null || (Number.isFinite(value) && value > 0 && (allowHundred || value < 100));
    const validPosition = (p: Position) => p && typeof p.id === 'string' && p.id !== ''
      && typeof p.strategy === 'string' && p.strategy !== '' && typeof p.symbol === 'string' && p.symbol !== ''
      && Number.isFinite(p.qty) && p.qty > 0 && Number.isFinite(p.entryPrice) && p.entryPrice > 0
      && Number.isFinite(p.entryTs) && p.entryTs >= 0 && Number.isFinite(p.sizeUsd) && p.sizeUsd > 0
      && validOptional(p.stopLossPct) && validOptional(p.takeProfitPct, true) && validOptional(p.maxHoldMin, true)
      && (p.entryFeeUsd === undefined || (Number.isFinite(p.entryFeeUsd) && p.entryFeeUsd >= 0))
      && (p.trailing === undefined || (p.trailing && Number.isFinite(p.trailing.peak) && p.trailing.peak >= p.entryPrice
        && Number.isFinite(p.trailing.afterPct) && p.trailing.afterPct > 0));
    const validTotals = c && Number.isFinite(c.cashUsd) && c.cashUsd >= 0
      && Number.isFinite(c.realizedUsd) && Number.isFinite(c.feesUsd) && c.feesUsd >= 0
      && Number.isSafeInteger(c.tradesClosed) && c.tradesClosed >= 0
      && Number.isSafeInteger(c.wins) && c.wins >= 0 && c.wins <= c.tradesClosed
      && Number.isSafeInteger(c.seq) && c.seq >= 0;
    if (!validTotals || !Array.isArray(c.positions) || c.positions.some((p) => !validPosition(p))
      || new Set(c.positions.map((p) => p.id)).size !== c.positions.length
      || new Set(c.positions.map((p) => this.key(p))).size !== c.positions.length) {
      throw new Error('invalid paper portfolio ledger checkpoint');
    }
    this.cashUsd = c.cashUsd;
    this.realizedUsd = c.realizedUsd;
    this.feesUsd = c.feesUsd;
    this.tradesClosed = c.tradesClosed;
    this.wins = c.wins;
    this.seq = c.seq;
    this.positions = new Map(c.positions.map((p) => [this.key(p), p]));
  }

  canOpen(i: TradeIntent): boolean {
    return !this.positions.has(this.key(i));
  }

  open(i: TradeIntent, price: number, feePct: number, ts = Date.now()): Fill | null {
    const usd = Math.min(i.sizeUsd ?? 500, this.cashUsd / (1 + feePct / 100));
    const validOptional = (value: number | null | undefined, allowHundred = false) =>
      value === undefined || value === null || (Number.isFinite(value) && value > 0 && (allowHundred || value < 100));
    if (!Number.isFinite(usd) || usd < 5 || !Number.isFinite(price) || price <= 0
      || !Number.isFinite(feePct) || feePct < 0 || !this.canOpen(i)
      || !validOptional(i.stopLossPct) || !validOptional(i.takeProfitPct, true) || !validOptional(i.maxHoldMin, true)) return null;
    const qty = usd / price;
    const fee = usd * (feePct / 100);
    this.cashUsd = Math.max(0, this.cashUsd - usd - fee);
    this.feesUsd += fee;
    const pos: Position = {
      id: `p${++this.seq}`,
      strategy: i.strategy,
      symbol: i.symbol,
      qty,
      entryPrice: price,
      entryTs: ts,
      sizeUsd: usd,
      entryFeeUsd: fee,
      stopLossPct: i.stopLossPct ?? null,
      takeProfitPct: i.takeProfitPct ?? null,
      maxHoldMin: i.maxHoldMin ?? null,
      ...(i.management && { trailing: { afterPct: i.management.trailAfterPct, peak: price } }),
    };
    this.positions.set(this.key(i), pos);
    return { id: pos.id, strategy: i.strategy, symbol: i.symbol, side: 'buy', qty, price, usd, feeUsd: fee, reason: i.reason, ts };
  }

  close(strategy: string, symbol: string, price: number, feePct: number, reason: string, ts = Date.now()): Fill | null {
    const key = `${strategy}|${symbol}`;
    const pos = this.positions.get(key);
    if (!pos || !Number.isFinite(price) || price <= 0 || !Number.isFinite(feePct) || feePct < 0) return null;
    const usd = pos.qty * price;
    const fee = usd * (feePct / 100);
    this.cashUsd += usd - fee;
    this.feesUsd += fee;
    const pnl = usd - fee - pos.sizeUsd - (pos.entryFeeUsd ?? 0);
    this.realizedUsd += pnl;
    this.tradesClosed += 1;
    if (pnl > 0) this.wins += 1;
    this.positions.delete(key);
    return { id: pos.id, strategy, symbol, side: 'sell', qty: pos.qty, price, usd, feeUsd: fee, reason, ts, pnlUsd: pnl };
  }

  equity(prices: Map<string, number>): number {
    let eq = this.cashUsd;
    for (const p of this.positions.values()) eq += p.qty * (prices.get(p.symbol) ?? p.entryPrice);
    return eq;
  }

  unrealized(prices: Map<string, number>): number {
    let u = 0;
    for (const p of this.positions.values()) u += p.qty * (prices.get(p.symbol) ?? p.entryPrice) - p.sizeUsd - (p.entryFeeUsd ?? 0);
    return u;
  }

  private key(i: { strategy: string; symbol: string }) {
    return `${i.strategy}|${i.symbol}`;
  }
}
