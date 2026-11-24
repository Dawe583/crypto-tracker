// Offline backtest: replay fetched candles through enabled strategies with
// PaperPortfolio accounting + SL/TP/maxHold exits. `npm run backtest`.
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Strategy } from './types.js';
import { loadStrategies } from '../strategies/registry.js';
import { refreshSymbol } from './market.js';
import { PaperPortfolio } from './portfolio.js';
import { config } from '../config.js';

const WARMUP = 60;

export interface BacktestRow {
  strategy: string;
  symbol: string;
  trades: number;
  winRate: number;
  pnlUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  maxDdUsd: number;
  bars: number;
}

// Replay one strategy (given params) over a candle series through PaperPortfolio.
export function replayOne(strategy: Strategy, params: Record<string, number>, symbol: string, candles: any[]): BacktestRow {
  const pf = new PaperPortfolio(10_000);
  const eq: number[] = [];
  for (let i = WARMUP; i < candles.length; i++) {
    const win = candles.slice(0, i + 1);
    const price = win[win.length - 1].c;
    const now = win[win.length - 1].t;
    for (const p of [...pf.positions.values()]) {           // exit rules on mark price
      const chg = ((price - p.entryPrice) / p.entryPrice) * 100;
      const held = (now - p.entryTs) / 60_000;
      if ((p.stopLossPct && chg <= -p.stopLossPct) || (p.takeProfitPct && chg >= p.takeProfitPct) || (p.maxHoldMin && held >= p.maxHoldMin))
        pf.close(p.strategy, p.symbol, price, config.engine.feePct, 'exit-rule');
    }
    const intents = strategy.evaluate({
      symbol, candles: win, price,
      positions: [...pf.positions.values()],
      signals: { whaleBuys: 0, newPools: 0, goldSpread: {} },
      params,
    });
    for (const it of intents) {
      if (it.confidence < config.engine.minConfidence) continue;
      if (it.side === 'buy') {
        const f = pf.open(it, price, config.engine.feePct);
        if (f) pf.positions.get(`${strategy.name}|${symbol}`)!.entryTs = now;
      } else pf.close(strategy.name, symbol, price, config.engine.feePct, it.reason);
    }
    eq.push(pf.equity(new Map([[symbol, price]])));
  }
  let peak = -Infinity, dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  const lastPrice = candles[candles.length - 1].c;
  return {
    strategy: strategy.name, symbol,
    trades: pf.tradesClosed,
    winRate: pf.tradesClosed ? +((pf.wins / pf.tradesClosed) * 100).toFixed(1) : 0,
    pnlUsd: +(pf.realizedUsd + pf.unrealized(new Map([[symbol, lastPrice]]))).toFixed(2),
    unrealizedUsd: +pf.unrealized(new Map([[symbol, lastPrice]])).toFixed(2),
    feesUsd: +pf.feesUsd.toFixed(2),
    maxDdUsd: +dd.toFixed(2),
    bars: candles.length - WARMUP,
  };
}

export async function runBacktest(symbols: string[] = config.engine.symbols, interval: string = config.engine.interval) {
  const strats = loadStrategies().filter((s) => s.enabled);
  const results: BacktestRow[] = [];
  for (const symbol of symbols) {
    const feed = await refreshSymbol(symbol, interval);
    const candles = feed?.candles ?? [];
    if (candles.length <= WARMUP + 5) { results.push({ strategy: '*', symbol, trades: 0, winRate: 0, pnlUsd: 0, unrealizedUsd: 0, feesUsd: 0, maxDdUsd: 0, bars: candles.length }); continue; }
    for (const st of strats)
      results.push(replayOne(st.strategy, st.params, symbol, candles));
  }
  mkdirSync('data', { recursive: true });
  writeFileSync(`data/backtest-${interval}.json`, JSON.stringify({ at: new Date().toISOString(), interval, results }, null, 2));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const syms = process.argv[2] ? process.argv[2].split(',') : undefined;
  const iv = process.argv[3];
  const rows = await runBacktest(syms, iv);
  console.log(`${'STRATEGY'.padEnd(20)} ${'SYM'.padEnd(8)} ${'TRADES'.padStart(6)} ${'WIN%'.padStart(6)} ${'PNL$'.padStart(9)} ${'MAXDD$'.padStart(8)} ${'FEES$'.padStart(7)}`);
  for (const r of rows)
    console.log(`${r.strategy.padEnd(20)} ${r.symbol.padEnd(8)} ${String(r.trades).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${r.pnlUsd.toFixed(2).padStart(9)} ${r.maxDdUsd.toFixed(2).padStart(8)} ${r.feesUsd.toFixed(2).padStart(7)}`);
  console.log(`\nwrote data/backtest-${iv ?? '1m'}.json`);
}
