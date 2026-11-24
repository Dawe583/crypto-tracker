// Engine loop: refresh candles -> exits first -> strategy eval -> risk veto ->
// paper fill -> ledger -> snapshot. One decision unit per cycle, hold when late.
import { logger } from '../logger.js';
import { config } from '../config.js';
import { refreshSymbol, getPrice } from './market.js';
import { PaperPortfolio } from './portfolio.js';
import { RiskEngine } from './risk.js';
import { ledgerAppend } from './ledger.js';
import { loadStrategies } from '../strategies/registry.js';
import { listSignals } from '../store.js';
import { getGoldSnapshot } from '../store.js';
import { engineState } from './state.js';
import type { DecisionRecord, TradeIntent } from './types.js';

export const portfolio = new PaperPortfolio(config.engine.startUsd);
export const risk = new RiskEngine({
  maxPositionUsd: config.engine.maxPositionUsd,
  maxTotalUsd: config.engine.maxTotalUsd,
  maxOpenPositions: config.engine.maxOpenPositions,
  dailyLossPct: config.engine.dailyLossPct,
  minConfidence: config.engine.minConfidence,
  cooldownMin: config.engine.cooldownMin,
  startEquityUsd: config.engine.startUsd,
});

const strategies = loadStrategies();
const equityCurve: { ts: number; equityUsd: number }[] = [];
const perStrategy = new Map<string, { pnl: number; trades: number; wins: number }>();

function statFor(name: string) {
  let s = perStrategy.get(name);
  if (!s) { s = { pnl: 0, trades: 0, wins: 0 }; perStrategy.set(name, s); }
  return s;
}

function monitorSignals() {
  const whales = listSignals('whale_buy', 50).filter((s) => Date.now() - Date.parse(s.createdAt) < 4 * 3600_000);
  const gold = getGoldSnapshot();
  const goldSpread: Record<string, number> = {};
  for (const q of gold.quotes) goldSpread[`${q.symbol}USD`] = q.deviationPct;
  return { whaleBuys: whales.length, newPools: listSignals('new_pool', 50).length, goldSpread };
}

function checkExits(prices: Map<string, number>) {
  for (const p of [...portfolio.positions.values()]) {
    const px = prices.get(p.symbol);
    if (!px) continue;
    const chg = ((px - p.entryPrice) / p.entryPrice) * 100;
    const ageMin = (Date.now() - p.entryTs) / 60000;
    let reason: string | null = null;
    if (p.stopLossPct !== null && chg <= -p.stopLossPct) reason = `stop loss ${chg.toFixed(1)}%`;
    else if (p.takeProfitPct !== null && chg >= p.takeProfitPct) reason = `take profit +${chg.toFixed(1)}%`;
    else if (p.maxHoldMin !== null && ageMin >= p.maxHoldMin) reason = 'max hold reached';
    if (!reason) continue;
    const fill = portfolio.close(p.strategy, p.symbol, px, config.engine.feePct, reason);
    if (fill) {
      risk.recordClose(p.strategy, fill.pnlUsd ?? 0);
      const st = statFor(p.strategy); st.pnl += fill.pnlUsd ?? 0; st.trades += 1; if ((fill.pnlUsd ?? 0) > 0) st.wins += 1;
      ledgerAppend('fill', fill);
      logger.info({ symbol: p.symbol, strategy: p.strategy, pnl: fill.pnlUsd }, 'position closed');
    }
  }
}

export async function runEngineCycle() {
  const symbols = config.engine.symbols;
  await Promise.all(symbols.map((s) => refreshSymbol(s, config.engine.interval)));
  const prices = new Map(symbols.map((s) => [s, getPrice(s) ?? 0]).filter(([, p]) => (p as number) > 0) as [string, number][]);

  checkExits(prices);
  const signals = monitorSignals();

  for (const { strategy, params, enabled } of strategies) {
    if (!enabled) continue;
    for (const symbol of symbols) {
      const feed = await import('./market.js').then((m) => m.getFeed(symbol));
      if (!feed || feed.candles.length < 30) continue;
      let intents: TradeIntent[] = [];
      try {
        intents = strategy.evaluate({ symbol, candles: feed.candles, price: feed.price, positions: [...portfolio.positions.values()], signals, params });
      } catch (e) { logger.warn({ err: String(e), strategy: strategy.name, symbol }, 'strategy eval failed'); }
      for (const i of intents) {
        const rec: DecisionRecord = { strategy: i.strategy, symbol, action: i.side, confidence: i.confidence, reason: i.reason, ts: Date.now() };
        if (i.side === 'sell') {
          const fill = portfolio.close(i.strategy, symbol, prices.get(symbol) ?? feed.price, config.engine.feePct, i.reason);
          if (fill) { risk.recordClose(i.strategy, fill.pnlUsd ?? 0); const st = statFor(i.strategy); st.pnl += fill.pnlUsd ?? 0; st.trades += 1; if ((fill.pnlUsd ?? 0) > 0) st.wins += 1; ledgerAppend('fill', fill); }
          rec.vetoed = fill ? undefined : 'no position to close';
          ledgerAppend('decision', rec);
          engineState.decisions.unshift(rec);
          continue;
        }
        const positions = [...portfolio.positions.values()];
        const exposure = positions.reduce((total, p) => {
          const mark = prices.get(p.symbol) ?? p.entryPrice;
          return total + (mark === p.entryPrice ? p.sizeUsd : p.qty * mark);
        }, 0);
        const veto = risk.check(i, positions, portfolio.equity(prices), exposure);
        if (veto) { rec.vetoed = veto; ledgerAppend('decision', rec); ledgerAppend('risk', rec); engineState.decisions.unshift(rec); continue; }
        const fill = portfolio.open(i, prices.get(symbol) ?? feed.price, config.engine.feePct);
        if (fill) {
          ledgerAppend('decision', rec);
          ledgerAppend('fill', fill);
          engineState.decisions.unshift(rec);
          logger.info({ symbol, strategy: i.strategy, usd: fill.usd }, 'position opened');
        } else { rec.vetoed = 'insufficient cash or duplicate position'; ledgerAppend('decision', rec); engineState.decisions.unshift(rec); }
      }
    }
  }

  const eq = portfolio.equity(prices);
  equityCurve.push({ ts: Date.now(), equityUsd: eq });
  if (equityCurve.length > 2000) equityCurve.shift();
  ledgerAppend('equity', { equityUsd: eq, cashUsd: portfolio.cashUsd, unrealizedUsd: portfolio.unrealized(prices) });
  engineState.snapshot = {
    equityUsd: eq,
    cashUsd: portfolio.cashUsd,
    realizedUsd: portfolio.realizedUsd,
    unrealizedUsd: portfolio.unrealized(prices),
    feesUsd: portfolio.feesUsd,
    positions: [...portfolio.positions.values()].map((p) => ({ ...p, markPrice: prices.get(p.symbol) ?? p.entryPrice, unrealizedUsd: p.qty * (prices.get(p.symbol) ?? p.entryPrice) - p.sizeUsd })),
    stats: Object.fromEntries([...perStrategy.entries()]),
    equityCurve: equityCurve.slice(-500),
    killed: risk.killed,
    prices: Object.fromEntries(prices),
    cycleAt: new Date().toISOString(),
  };
  if (engineState.decisions.length > 300) engineState.decisions.length = 300;
}

export function startEngineLoop() {
  const enabled = strategies.filter((s) => s.enabled).map((s) => s.strategy.name);
  logger.info({ strategies: enabled, symbols: config.engine.symbols, interval: config.engine.interval }, 'trading engine starting');
  const tick = () => runEngineCycle().catch((e) => logger.error({ err: String(e) }, 'engine cycle failed'));
  tick();
  return setInterval(tick, config.engine.pollMs);
}
