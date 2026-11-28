// Offline single-symbol replay: closed-bar signals, next-open fills, shared paper costs and risk.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Candle, Strategy } from './types.js';
import { loadStrategies } from '../strategies/registry.js';
import { completedCandles, intervalMs, refreshSymbol } from './market.js';
import { PaperPortfolio } from './portfolio.js';
import { RiskEngine } from './risk.js';
import { managedSize, MANAGED_SLIPPAGE_BPS, positionExit, slippedPrice } from './execution.js';
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
// feePct/slipBps override execution costs: slip worsens fills (buy higher, sell lower).
export function replayOne(strategy: Strategy, params: Record<string, number>, symbol: string, candles: Candle[],
  feePct = config.engine.feePct, slipBps = MANAGED_SLIPPAGE_BPS, barMs?: number): BacktestRow {
  if (!Number.isFinite(feePct) || feePct < 0 || !Number.isFinite(slipBps) || slipBps < 0 || slipBps >= 10_000)
    throw new Error('Invalid replay execution costs');
  const startUsd = config.engine.startUsd;
  const pf = new PaperPortfolio(startUsd);
  const risk = new RiskEngine({ ...config.engine, startEquityUsd: startUsd }, candles[0]?.t, false);
  const warmup = strategy.closedBars ?? WARMUP;
  const marks = new Map<string, number>();
  let peak = startUsd, dd = 0, bars = 0;
  const sampleEquity = (price: number) => {
    marks.set(symbol, price);
    const equity = pf.equity(marks);
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  };
  const key = `${strategy.name}|${symbol}`;
  for (let i = warmup; i < candles.length; i++) {
    const { t: now, o: price } = candles[i];
    const history = candles.slice(Math.max(0, i - (strategy.closedBars ?? 300)), i);
    const prior = history[history.length - 1];
    const sell = (reason: string) => {
      const fill = pf.close(strategy.name, symbol, slippedPrice(price, 'sell', slipBps), feePct, reason, now);
      if (fill) risk.recordClose(strategy.name, fill.pnlUsd!, now);
    };
    const position = pf.positions.get(key);
    const exit = position && positionExit(position, price, now);
    sampleEquity(price);
    if (exit) sell(exit);
    // A missing bar cannot be used as the next-open execution for its predecessor.
    if (barMs === undefined || (now - prior.t === barMs
      && history.every((c, j) => j === 0 || c.t - history[j - 1].t === barMs))) {
      bars++;
      const intents = strategy.evaluate({ symbol, candles: history, price: prior.c, positions: [...pf.positions.values()],
        signals: { whaleBuys: 0, newPools: 0, goldSpread: {} }, params });
      for (const it of intents) {
        if (it.side === 'sell') { sell(it.reason); continue; }
        if (exit) continue;
        const equity = pf.equity(marks);
        const exposure = (pf.positions.get(key)?.qty ?? 0) * price;
        const cap = Math.min(config.engine.maxPositionUsd, config.engine.maxTotalUsd - exposure);
        const sizeUsd = it.management ? managedSize(it, equity, feePct, slipBps, cap) : it.sizeUsd;
        if ((it.management && !((sizeUsd ?? 0) >= 5)) || risk.check({ ...it, sizeUsd }, [...pf.positions.values()], equity, exposure, now)) continue;
        pf.open({ ...it, sizeUsd }, slippedPrice(price, 'buy', slipBps), feePct, now);
      }
    }
    sampleEquity(price);
  }
  if (candles.length) sampleEquity(candles[candles.length - 1].c);
  return {
    strategy: strategy.name, symbol,
    trades: pf.tradesClosed,
    winRate: pf.tradesClosed ? +((pf.wins / pf.tradesClosed) * 100).toFixed(1) : 0,
    pnlUsd: +(pf.equity(marks) - startUsd).toFixed(2),
    unrealizedUsd: +pf.unrealized(marks).toFixed(2),
    feesUsd: +pf.feesUsd.toFixed(2),
    maxDdUsd: +dd.toFixed(2),
    bars,
  };
}

export function readBinanceCandles(path: string, stepMs: number): Candle[] {
  // Binance spot archive timestamps are microseconds from 2025 onward.
  const candles = readFileSync(path, 'utf8').trim().split(/\r?\n/).map((row) => {
    const [timestamp, o, h, l, c, v] = row.split(',').map((value) => value.trim() === '' ? NaN : Number(value));
    const t = timestamp >= 1e15 ? timestamp / 1000 : timestamp;
    return { t, o, h, l, c, v };
  });
  if (!Number.isSafeInteger(stepMs) || stepMs <= 0 || candles.some(({ t, o, h, l, c, v }, i) =>
    !Number.isSafeInteger(t) || t <= 0 || ![o, h, l, c].every((p) => Number.isFinite(p) && p > 0)
    || h < Math.max(o, c) || l > Math.min(o, c) || !Number.isFinite(v) || v < 0
    || (i > 0 && t - candles[i - 1].t !== stepMs))) throw new Error('Invalid or non-contiguous Binance OHLCV CSV');
  return candles;
}

export async function runBacktest(symbols: string[] = config.engine.symbols, interval: string = config.engine.interval,
  archive?: string, names?: string[]) {
  const strats = loadStrategies().filter((s) => names ? names.includes(s.strategy.name) : s.enabled);
  if (names && names.some((name) => !strats.some((s) => s.strategy.name === name))) throw new Error('Unknown replay strategy');
  if (archive && symbols.length !== 1) throw new Error('Use one symbol per Binance CSV');
  const stepMs = intervalMs(interval);
  if (!Number.isSafeInteger(stepMs) || stepMs <= 0 || interval.endsWith('M')) throw new Error('Replay requires a fixed candle interval');
  const results: BacktestRow[] = [];
  let file = `data/replay/backtest-${interval}.json`;
  for (const symbol of symbols) {
    const feed = archive ? null : await refreshSymbol(symbol, interval);
    const candles = archive ? readBinanceCandles(archive, stepMs) : feed ? completedCandles(feed, interval) : [];
    if (archive) file = `data/replay/backtest-${interval}-${encodeURIComponent(symbol)}-${candles[0].t}-${candles.at(-1)!.t}.json`;
    for (const st of strats)
      results.push(replayOne(st.strategy, st.params, symbol, candles, undefined, undefined, stepMs));
  }
  mkdirSync('data/replay', { recursive: true });
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), interval, results }, null, 2));
  return { file, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const syms = process.argv[2] ? process.argv[2].split(',') : undefined;
  const iv = process.argv[3];
  const { results: rows, file } = await runBacktest(syms, iv, process.argv[4], process.argv[5]?.split(','));
  console.log(`${'STRATEGY'.padEnd(20)} ${'SYM'.padEnd(8)} ${'TRADES'.padStart(6)} ${'WIN%'.padStart(6)} ${'PNL$'.padStart(9)} ${'MAXDD$'.padStart(8)} ${'FEES$'.padStart(7)}`);
  for (const r of rows)
    console.log(`${r.strategy.padEnd(20)} ${r.symbol.padEnd(8)} ${String(r.trades).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${r.pnlUsd.toFixed(2).padStart(9)} ${r.maxDdUsd.toFixed(2).padStart(8)} ${r.feesUsd.toFixed(2).padStart(7)}`);
  console.log(`\nwrote ${file}`);
}
