// Engine loop: refresh candles -> exits first -> strategy eval -> risk veto ->
// paper fill -> ledger -> snapshot. One decision unit per cycle, hold when late.
import { logger } from '../logger.js';
import { config } from '../config.js';
import { refreshSymbol, type Feed } from './market.js';
import { PaperPortfolio } from './portfolio.js';
import { RiskEngine } from './risk.js';
import { ledgerAppend, ledgerResumeLatestCheckpoint, type LedgerRecord } from './ledger.js';
import { loadStrategies } from '../strategies/registry.js';
import { getGoldSnapshot, listSignals } from '../store.js';
import { engineState } from './state.js';
import { watchedAddresses } from '../wallets.js';
import type { DecisionRecord, Fill, StrategyContext, TradeIntent } from './types.js';

export type EngineCheckpoint = {
  portfolio: ReturnType<PaperPortfolio['checkpoint']>;
  risk: ReturnType<RiskEngine['checkpoint']>;
  stats: [string, { pnl: number; trades: number; wins: number }][];
};

export function createPaperEngine(options: {
  state: typeof engineState;
  append: (type: LedgerRecord['type'], data: unknown) => void;
  refresh: (symbol: string, interval: string) => Promise<Feed | null>;
  signals: () => StrategyContext['signals'];
  strategies?: ReturnType<typeof loadStrategies>;
}) {
  const { state } = options;
  const portfolio = new PaperPortfolio(config.engine.startUsd);
  const risk = new RiskEngine({
    maxPositionUsd: config.engine.maxPositionUsd,
    maxTotalUsd: config.engine.maxTotalUsd,
    maxOpenPositions: config.engine.maxOpenPositions,
    dailyLossPct: config.engine.dailyLossPct,
    minConfidence: config.engine.minConfidence,
    cooldownMin: config.engine.cooldownMin,
    startEquityUsd: config.engine.startUsd,
  });
  const strategies = options.strategies ?? loadStrategies();
  const equityCurve = [...(state.snapshot?.equityCurve ?? [])];
  const perStrategy = new Map<string, { pnl: number; trades: number; wins: number }>();

  function checkpointState(): EngineCheckpoint {
    return { portfolio: portfolio.checkpoint(), risk: risk.checkpoint(), stats: [...perStrategy] };
  }

  function restore(checkpoint: EngineCheckpoint) {
    portfolio.restoreCheckpoint(checkpoint.portfolio);
    risk.restoreCheckpoint(checkpoint.risk);
    for (const [name, stats] of checkpoint.stats) perStrategy.set(name, stats);
  }

  function append(type: LedgerRecord['type'], data: unknown) {
    try {
      options.append(type, data);
    } catch (err) {
      state.halted = true;
      throw err;
    }
  }

  function statFor(name: string) {
    let s = perStrategy.get(name);
    if (!s) { s = { pnl: 0, trades: 0, wins: 0 }; perStrategy.set(name, s); }
    return s;
  }

  function recordFill(fill: Fill) {
    if (fill.side === 'sell') {
      const pnl = fill.pnlUsd ?? 0;
      risk.recordClose(fill.strategy, pnl);
      const stats = statFor(fill.strategy);
      stats.pnl += pnl;
      stats.trades += 1;
      if (pnl > 0) stats.wins += 1;
    }
    append('fill', { ...fill, checkpoint: checkpointState() });
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
        recordFill(fill);
        logger.info({ symbol: p.symbol, strategy: p.strategy, pnl: fill.pnlUsd }, 'position closed');
      }
    }
  }

  async function cycle() {
    if (state.halted) throw new Error('paper ledger unavailable; restart required');
    const symbols = config.engine.symbols;
    const marketSymbols = [...new Set([...symbols, ...Array.from(portfolio.positions.values(), (p) => p.symbol)])];
    const feeds = new Map<string, Feed>();
    for (const [symbol, feed] of await Promise.all(marketSymbols.map(async (symbol) =>
      [symbol, await options.refresh(symbol, config.engine.interval)] as const))) {
      if (feed && Number.isFinite(feed.price) && feed.price > 0) feeds.set(symbol, feed);
    }
    if (state.halted || !feeds.size) return feeds;
    const prices = new Map([...feeds].map(([symbol, feed]) => [symbol, feed.price] as const));

    checkExits(prices);
    const signals = options.signals();

    for (const { strategy, params, enabled } of strategies) {
      if (!enabled) continue;
      for (const symbol of symbols) {
        const feed = feeds.get(symbol);
        if (!feed || feed.candles.length < 30) continue;
        let intents: TradeIntent[] = [];
        try {
          intents = strategy.evaluate({ symbol, candles: feed.candles, price: feed.price, positions: [...portfolio.positions.values()], signals, params });
        } catch (e) { logger.warn({ err: String(e), strategy: strategy.name, symbol }, 'strategy eval failed'); }
        for (const i of intents) {
          const rec: DecisionRecord = { strategy: i.strategy, symbol, action: i.side, confidence: i.confidence, reason: i.reason, ts: Date.now() };
          if (i.side === 'sell') {
            const fill = portfolio.close(i.strategy, symbol, feed.price, config.engine.feePct, i.reason);
            if (fill) recordFill(fill);
            rec.vetoed = fill ? undefined : 'no position to close';
            append('decision', rec);
            state.decisions.unshift(rec);
            continue;
          }
          const positions = [...portfolio.positions.values()];
          const exposure = positions.reduce((total, p) => {
            const mark = prices.get(p.symbol) ?? p.entryPrice;
            return total + (mark === p.entryPrice ? p.sizeUsd : p.qty * mark);
          }, 0);
          const baselineDay = risk.baselineDay;
          const veto = positions.some((p) => !prices.has(p.symbol))
            ? 'market price unavailable for an open position'
            : risk.check(i, positions, portfolio.equity(prices), exposure);
          if (risk.baselineDay !== baselineDay) append('checkpoint', { checkpoint: checkpointState() });
          if (veto) { rec.vetoed = veto; append('decision', rec); append('risk', rec); state.decisions.unshift(rec); continue; }
          const fill = portfolio.open(i, feed.price, config.engine.feePct);
          if (fill) {
            recordFill(fill);
            append('decision', rec);
            state.decisions.unshift(rec);
            logger.info({ symbol, strategy: i.strategy, usd: fill.usd }, 'position opened');
          } else { rec.vetoed = 'insufficient cash or duplicate position'; append('decision', rec); state.decisions.unshift(rec); }
        }
      }
    }

    const positions = [...portfolio.positions.values()];
    const marks = new Map<string, number>();
    for (const symbol of new Set([...symbols, ...positions.map((p) => p.symbol)])) {
      const mark = prices.get(symbol) ?? state.snapshot?.prices[symbol];
      if (mark !== undefined) marks.set(symbol, mark);
    }
    for (const p of positions) {
      const priorMark = state.snapshot?.positions.find((previous) => previous.id === p.id)?.markPrice;
      if (!marks.has(p.symbol) && priorMark !== undefined) marks.set(p.symbol, priorMark);
    }
    const eq = portfolio.equity(marks);
    const unrealizedUsd = portfolio.unrealized(marks);
    if (positions.every((p) => prices.has(p.symbol))) {
      equityCurve.push({ ts: Date.now(), equityUsd: eq });
      if (equityCurve.length > 2000) equityCurve.shift();
      append('equity', { equityUsd: eq, cashUsd: portfolio.cashUsd, unrealizedUsd });
    }
    state.snapshot = {
      equityUsd: eq,
      cashUsd: portfolio.cashUsd,
      realizedUsd: portfolio.realizedUsd,
      unrealizedUsd,
      feesUsd: portfolio.feesUsd,
      positions: positions.map((p) => {
        const markPrice = marks.get(p.symbol) ?? p.entryPrice;
        return { ...p, markPrice, unrealizedUsd: p.qty * markPrice - p.sizeUsd };
      }),
      stats: Object.fromEntries([...perStrategy.entries()]),
      equityCurve: equityCurve.slice(-500),
      killed: risk.killed,
      prices: Object.fromEntries(marks),
      cycleAt: new Date().toISOString(),
    };
    if (state.decisions.length > 300) state.decisions.length = 300;
    return feeds;
  }

  return { portfolio, risk, cycle, restore, checkpoint: checkpointState };
}

const watchedWallets = {
  base: new Set(watchedAddresses('base').map((address) => address.toLowerCase())),
  ethereum: new Set(watchedAddresses('ethereum').map((address) => address.toLowerCase())),
};

function monitorSignals() {
  const now = Date.now();
  const whales = listSignals('whale_buy', Infinity).filter((s) => {
    const wallet = s.whale?.wallet;
    const age = now - Date.parse(s.createdAt);
    return typeof wallet === 'string' && watchedWallets[s.chain].has(wallet.toLowerCase()) && age >= 0 && age < 4 * 3600_000;
  });
  const gold = getGoldSnapshot();
  const goldSpread: Record<string, number> = {};
  for (const q of gold.quotes) {
    const symbol = `${q.symbol}USD`;
    if (!q.stale && (q.chain === 'base' || goldSpread[symbol] === undefined)) goldSpread[symbol] = q.deviationPct;
  }
  return { whaleBuys: Math.min(whales.length, 50), newPools: listSignals('new_pool', 50).length, goldSpread };
}

const strategies = loadStrategies();
const local = createPaperEngine({
  state: engineState, append: ledgerAppend, signals: monitorSignals, strategies,
  refresh: (symbol, interval) => refreshSymbol(symbol, interval, { requireRecent: true }),
});
export const { portfolio, risk } = local;
let recovered = false;

export async function runEngineCycle() {
  if (engineState.halted) throw new Error('paper ledger unavailable; restart required');
  if (!recovered) {
    try {
      const previous = ledgerResumeLatestCheckpoint<{ checkpoint?: EngineCheckpoint }>();
      if (previous?.data.checkpoint) local.restore(previous.data.checkpoint);
      else if (previous?.type === 'checkpoint') throw new Error('invalid paper ledger checkpoint');
      else if (previous) logger.warn('legacy paper ledger fill has no checkpoint; starting a new simulated portfolio');
      recovered = true;
    } catch (err) {
      engineState.halted = true;
      throw err;
    }
  }
  await local.cycle();
}

export function startEngineLoop() {
  const enabled = strategies.filter((s) => s.enabled).map((s) => s.strategy.name);
  logger.info({ strategies: enabled, symbols: config.engine.symbols, interval: config.engine.interval }, 'trading engine starting');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runEngineCycle();
    } catch (e) {
      logger.error({ err: String(e) }, 'engine cycle failed');
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, config.engine.pollMs);
}
