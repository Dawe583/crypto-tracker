// Parameter sweep: grid-search strategy params over cached candles, ranked by pnl - 0.5*maxDd.
// `npm run sweep [strategy|all] [interval]` — writes data/sweep-<strategy>-<interval>.json.
import { writeFileSync } from 'node:fs';
import { loadStrategies } from '../strategies/registry.js';
import { refreshSymbol } from './market.js';
import { replayOne } from './backtest.js';
import { config } from '../config.js';

// Grid axes per strategy (keep small: <= ~48 combos each).
const GRIDS: Record<string, Record<string, number[]>> = {
  rsi_reversion: { n: [10, 14], oversold: [25, 30, 35], exitAt: [50, 55], stopLossPct: [4, 6], takeProfitPct: [5, 8] },
  stoch_cross: { k: [10, 14], zone: [15, 20, 25], stopLossPct: [3, 5], takeProfitPct: [5, 8] },
  ema_cross: { fast: [8, 12], slow: [21, 34, 55], stopLossPct: [4, 6], takeProfitPct: [8, 12] },
  zscore_reversion: { n: [30, 50], entryZ: [-2, -2.5], exitZ: [0, 0.5], stopLossPct: [5, 8] },
  breakout: { n: [20, 40], volMult: [1.5, 2.5], stopLossPct: [3.5, 5], takeProfitPct: [9, 12] },
  obv_drift: { n: [15, 20, 30], stopLossPct: [4, 6], takeProfitPct: [6, 10] },
  bollinger_reversion: { n: [15, 20], mult: [1.8, 2, 2.5], stopLossPct: [4, 6], takeProfitPct: [5, 8] },
  donchian: { n: [20, 30, 50], stopLossPct: [4, 6], takeProfitPct: [8, 12] },
  vwap_reversion: { n: [40, 60], devPct: [1, 1.5, 2.5], stopLossPct: [4, 6], takeProfitPct: [4, 6] },
  roc_momentum: { n: [6, 10, 15], entry: [0.8, 1.5], stopLossPct: [3, 4], takeProfitPct: [5, 7] },
  atr_trend: { n: [10, 14], mult: [2, 3], stopLossPct: [4, 6], takeProfitPct: [6, 10] },
  engulfing: { volMult: [1.3, 2], stopLossPct: [3, 4], takeProfitPct: [5, 7] },
  macd_momentum: { stopLossPct: [3, 5], takeProfitPct: [6, 10] },
  vol_spike: { mult: [2, 3, 4], stopLossPct: [3, 4], takeProfitPct: [5, 8] },
};

function* combos(grid: Record<string, number[]>): Generator<Record<string, number>> {
  const keys = Object.keys(grid);
  if (!keys.length) { yield {}; return; }
  const idx = keys.map(() => 0);
  for (;;) {
    const out: Record<string, number> = {};
    keys.forEach((k, i) => (out[k] = grid[k][idx[i]]));
    yield out;
    for (let i = keys.length - 1; i >= 0; i--) {
      if (++idx[i] < grid[keys[i]].length) break;
      idx[i] = 0;
      if (i === 0) return;
    }
  }
}

export async function runSweep(stratName: string, symbols: string[] = config.engine.symbols, interval = '15m') {
  const st = loadStrategies().find((s) => s.strategy.name === stratName);
  if (!st) throw new Error(`unknown strategy ${stratName}`);
  const grid = GRIDS[stratName] ?? {};
  const candleMap: Record<string, any[]> = {};
  for (const symbol of symbols) {
    const feed = await refreshSymbol(symbol, interval);
    candleMap[symbol] = feed?.candles ?? [];
  }
  const rows: any[] = [];
  for (const params of combos(grid)) {
    let pnl = 0, dd = 0, trades = 0;
    const merged = { ...st.params, ...params };
    for (const symbol of symbols) {
      if (!candleMap[symbol].length) continue;
      const r = replayOne(st.strategy, merged, symbol, candleMap[symbol]);
      pnl += r.pnlUsd; dd += r.maxDdUsd; trades += r.trades;
    }
    rows.push({ params: merged, pnlUsd: +pnl.toFixed(2), maxDdUsd: +dd.toFixed(2), trades, score: +(pnl - 0.5 * dd).toFixed(2) });
  }
  rows.sort((a, b) => b.score - a.score);
  const file = `data/sweep-${stratName}-${interval}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), strategy: stratName, interval, symbols, results: rows.slice(0, 20) }, null, 2));
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2] ?? 'all';
  const iv = process.argv[3] ?? '15m';
  const names = name === 'all' ? Object.keys(GRIDS) : [name];
  for (const n of names) {
    const rows = await runSweep(n, undefined, iv);
    const best = rows[0];
    console.log(`${n.padEnd(20)} best score ${String(best.score).padStart(8)} pnl ${String(best.pnlUsd).padStart(8)} dd ${String(best.maxDdUsd).padStart(8)} trades ${best.trades}  ${JSON.stringify(Object.fromEntries(Object.entries(best.params).filter(([k]) => (GRIDS[n] ?? {})[k])))}`);
  }
}
