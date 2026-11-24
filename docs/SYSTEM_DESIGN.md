# Autonomous Trading System — design

Goal: crypto-tracker grows from a monitor into a full paper-first autonomous trading research system on a Raspberry Pi 4. Design borrows the best verified ideas from the surveyed repos (see docs/AUDIT_AND_TRADING_LANDSCAPE.md).

## What each repo contributes

| Source | Idea taken |
|---|---|
| `jarrodwatts/jev-trader` | Decision loop shape: market state in → typed decision out, one decision unit per cycle, hold when late, full event stream. |
| `imikerussell/beebots` | Risk layer in plain code that can veto anything; paper trading default; every decision labelled with who made it. |
| `virattt/ai-hedge-fund` | Funds = data, not code (strategies defined in JSON mandates, pick a universe per run); hash-chained paper ledger so NAV is an auditable track record; kill switch. |
| `TauricResearch/TradingAgents` | Every logged decision gets settled later against real market outcome → reflection loop shows which strategy actually decided well. |
| `nautechsystems/nautilus_trader` | Event-driven parity: the same intent/fill path for live data now and backtest replay later. |
| `TraderAlice/OpenAlice` | Human approval stage for execution ("trading as git"): strategies stage intents, a human or the risk layer commits. Live trading stays opt-in later. |
| `freqtrade` | Dry-run/paper discipline, fee accounting, strategy-as-config. |
| Crypto-tracker (this repo) | Whale/pool/gold signals become strategy inputs — the unique edge nobody else has. |

## Architecture

```
Binance/Bybit public klines ──┐
crypto-tracker signals ───────┤
  (whales, pools, gold)       │
                              ▼
                     engine/market.ts     candles + latest price per symbol
                              │
      strategies/*.ts ────────┤  12+ strategies, each a pure evaluator:
                              │  (candles, signals, positions) → TradeIntent[]
                              ▼
                     engine/risk.ts       HARD veto layer (code, not AI):
                              │           exposure caps, daily-loss breaker,
                              │           cooldown, kill switch, position limits
                              ▼
                     engine/executor.ts   paper fills: price ± slippage + fees
                              │
                     engine/portfolio.ts  positions, cash, realized/unrealized PnL
                              │
                     engine/ledger.ts     append-only hash-chained JSONL
                              │           (decisions, fills, equity, settlements)
                              ▼
                     store + api.ts       /api/engine/* + /deck static UI
```

Decision engine (`engine/decisions.ts`) is a pluggable interface, exactly like jev-trader's `Model`:

- `code` (default): strategies evaluate deterministically in-process. Zero external calls, works offline on the Pi.
- `jev` / `llm` adapter slot: sends compact market state + typed questions to a decision model (TypeSafe Jev via `TYPESAFE_AI_API_KEY`, or any OpenAI-compatible endpoint). Falls back to `code` when unconfigured — the system is fully useful without any paid AI key.

## Strategy library (`data/strategies.json` → `src/strategies/`)

Each strategy is a pure evaluator producing `TradeIntent {symbol, side, confidence, reason, sizeUsd?, stopLossPct?, takeProfitPct?, maxHoldMin?}` — this is the freqtrade/jev pattern: narrow typed calls, code does the rest.

v1 ships 12 strategies, all toggleable + parameterizable at runtime via `data/strategies.json`:

| # | Strategy | Edge it tests |
|---|---|---|
| 1 | ema_cross | fast/slow EMA crossover trend entries |
| 2 | rsi_reversion | buy RSI extremes in ranging markets |
| 3 | bollinger_reversion | fade band touches back to mean |
| 4 | breakout | N-period high break + volume confirm |
| 5 | macd_momentum | MACD histogram sign flips |
| 6 | vol_spike | abnormal volume bar → momentum continuation |
| 7 | atr_trend | EMA trend + ATR-scaled stops (trend follower) |
| 8 | grid | static grid buys/sells around mid (range harvester) |
| 9 | dca | periodic accumulation entries for comparison baseline |
| 10 | zscore_reversion | price z-score vs rolling window |
| 11 | whale_follow | opens when crypto-tracker reports a watched-whale buy on that symbol family |
| 12 | gold_spread | trades the gold-RWA premium/discount signal direction |

Exits are engine-managed (SL/TP/max-hold from the intent + strategy close signals) — freqtrade-style, so exits stay honest even when the entry logic is naive.

## Risk layer (code, unconditional)

- `KILL_SWITCH` file `data/KILL` or env → halts all new entries, closes nothing (positions still managed).
- Per-symbol and total exposure caps, max open positions, per-trade size cap.
- Daily loss circuit breaker (`RISK_DAILY_LOSS_PCT`) → all entries stop for the day.
- Per-strategy consecutive-loss cooldown.
- Every veto is logged to the ledger (auditable why a trade did NOT happen).

## Paper ledger (`data/ledger/YYYY-MM-DD.jsonl`)

Append-only JSONL; each record `{seq, ts, type, prevHash, hash, data}`. Each fill checkpoints open positions and their original exit rules, cash, PnL, fees, trade IDs, and risk state. The engine also checkpoints when it sets a new daily loss baseline, even if the trade is vetoed. At startup it validates the ledger tail and restores the latest checkpoint before evaluating trades. If the clock moves backward, records keep their actual timestamps but are written to the newest UTC day file to preserve append order.

Older fills lack the state needed for exact recovery. If the latest fill predates checkpoints, the engine starts a new paper portfolio and leaves the old ledger intact, including any legacy fork from a clock rollback. An incomplete or invalid ledger tail stops paper trading until the ledger is repaired and the service restarted; it isn't silently discarded.

`GET /api/engine/snapshot` includes `halted` even before the first successful cycle. It is set on ledger recovery or append failure, separately from the `killed` switch.

Each exchange request has a five-second timeout. Paper fills use only candles fetched in the current cycle. At fetch time, the latest candle must have opened no more than two configured intervals ago and no more than five seconds in the future. If no exchange refreshes any symbol, the snapshot and equity curve stay unchanged. Snapshot `prices` can include cached prices so charts stay selectable; candle responses include `lastFetch`. Unavailable positions use their last fetched price (or entry price after restart) for display only. Missing prices on any held position pause new entries and equity recording until the portfolio can be fully marked; exits can still use a refreshed price.

## Trading deck (`/deck` on the API port)

Self-contained dark dashboard (no build step, works offline on the Pi — plain HTML/JS/canvas):

- NAV + equity curve, day PnL, per-strategy leaderboard (PnL, trades, win rate)
- open positions with live marks, decision feed (who decided, why, vetoed?)
- market strip for watched symbols
- panels fed by the existing monitor: whale buys, new pools, gold-RWA spread
- risk panel: exposure, daily P&L vs breaker, kill switch toggle (POST /api/engine/kill, API_TOKEN protected)

## Path to live (unchanged discipline)

`paper (now)` → exchange testnet adapter (Binance testnet / Bybit demo — same intent/fill path, nautilus-style parity) → live with trade-only keys, withdrawals off, tiny size, kill switch.
