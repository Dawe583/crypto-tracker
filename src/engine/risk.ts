// Hard risk layer in plain code (beebots lesson): it can veto ANYTHING, and
// every veto is written to the ledger so skipped trades are auditable.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradeIntent, Position } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const KILL_FILE = join(here, '..', '..', 'data', 'KILL');

export interface RiskConfig {
  maxPositionUsd: number;
  maxTotalUsd: number;
  maxOpenPositions: number;
  dailyLossPct: number;
  minConfidence: number;
  cooldownMin: number;
  startEquityUsd: number;
}

export class RiskEngine {
  private dayStart = new Date().toDateString();
  private dayStartEquity: number;
  private losses = new Map<string, { n: number; until: number }>();
  killed = existsSync(KILL_FILE);

  constructor(private cfg: RiskConfig) {
    this.dayStartEquity = cfg.startEquityUsd;
  }

  checkpoint() {
    return { dayStart: this.dayStart, dayStartEquity: this.dayStartEquity, losses: [...this.losses] };
  }

  restoreCheckpoint(c: ReturnType<RiskEngine['checkpoint']>) {
    this.dayStart = c.dayStart;
    this.dayStartEquity = c.dayStartEquity;
    this.losses = new Map(c.losses);
  }

  startDay(equity: number): boolean {
    const today = new Date().toDateString();
    if (today === this.dayStart) return false;
    this.dayStart = today;
    this.dayStartEquity = equity;
    return true;
  }

  // returns null when allowed, else the veto reason (logged to ledger)
  check(i: TradeIntent, positions: Position[], equity: number, exposureUsd: number): string | null {
    if (this.killed || existsSync(KILL_FILE)) { this.killed = true; return 'kill switch ON (data/KILL)'; }
    if (equity < this.dayStartEquity * (1 - this.cfg.dailyLossPct / 100)) {
      return `daily loss breaker (${this.cfg.dailyLossPct}%)`;
    }
    if (i.side === 'sell') return null; // exits always allowed
    if (i.confidence < this.cfg.minConfidence) return `confidence ${i.confidence} < ${this.cfg.minConfidence}`;
    if (positions.length >= this.cfg.maxOpenPositions) return 'max open positions';
    if ((i.sizeUsd ?? 0) > this.cfg.maxPositionUsd) return `size > ${this.cfg.maxPositionUsd}`;
    if (exposureUsd + (i.sizeUsd ?? 0) > this.cfg.maxTotalUsd) return 'total exposure cap';
    const cd = this.losses.get(i.strategy);
    if (cd && cd.until > Date.now()) return `strategy cooldown until ${new Date(cd.until).toISOString()}`;
    return null;
  }

  recordClose(strategy: string, pnlUsd: number) {
    const cur = this.losses.get(strategy) ?? { n: 0, until: 0 };
    cur.n = pnlUsd < 0 ? cur.n + 1 : 0;
    cur.until = cur.n >= 2 ? Date.now() + this.cfg.cooldownMin * 60_000 : 0;
    this.losses.set(strategy, cur);
  }
}
