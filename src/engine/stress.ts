// Cost sensitivity: replay top strategies across fee x slippage grid.
// `npm run stress [interval]` — writes data/stress-<interval>.json + prints matrix.
import { writeFileSync } from 'node:fs';
import { loadStrategies } from '../strategies/registry.js';
import { refreshSymbol } from './market.js';
import { replayOne } from './backtest.js';
import { config } from '../config.js';

const TOP = ['ema_cross', 'stoch_cross', 'obv_drift', 'rsi_reversion', 'breakout', 'zscore_reversion'];
const FEES = [0.05, 0.1, 0.2];          // % per side
const SLIPS = [0, 5, 20];               // bps per fill

export async function runStress(symbols: string[] = config.engine.symbols, interval = '15m') {
  const strats = loadStrategies().filter((s) => TOP.includes(s.strategy.name));
  const candleMap: Record<string, any[]> = {};
  for (const sym of symbols) candleMap[sym] = (await refreshSymbol(sym, interval))?.candles ?? [];
  const rows: any[] = [];
  for (const st of strats)
    for (const fee of FEES)
      for (const slip of SLIPS) {
        let pnl = 0, trades = 0;
        for (const sym of symbols) {
          if (!candleMap[sym].length) continue;
          const r = replayOne(st.strategy, st.params, sym, candleMap[sym], fee, slip);
          pnl += r.pnlUsd; trades += r.trades;
        }
        rows.push({ strategy: st.strategy.name, feePct: fee, slipBps: slip, pnlUsd: +pnl.toFixed(2), trades });
      }
  const file = `data/stress-${interval}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), interval, symbols, results: rows }, null, 2));
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const iv = process.argv[2] ?? '15m';
  const rows = await runStress(undefined, iv);
  const names = [...new Set(rows.map((r) => r.strategy))];
  console.log(`${'STRATEGY'.padEnd(20)} ` + FEES.map((f) => `f${f}%`.padStart(30)).join(''));
  console.log(`${''.padEnd(20)} ` + FEES.map(() => SLIPS.map((s) => `${s}bps`.padStart(8)).join('')).join(''));
  for (const n of names) {
    const cells = FEES.map((f) => SLIPS.map((s) => {
      const r = rows.find((x) => x.strategy === n && x.feePct === f && x.slipBps === s);
      return (r ? r.pnlUsd.toFixed(1) : '-').padStart(8);
    }).join(''));
    console.log(`${n.padEnd(20)} ${cells.join('')}`);
  }
}
