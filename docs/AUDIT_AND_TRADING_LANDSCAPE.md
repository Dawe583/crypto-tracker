# crypto-tracker: audit + open-source trading landscape

Date: 2026-11-23. Verified by running the repo live in the cloud.

## Part 1: What crypto-tracker does today

A Node.js/TypeScript daemon (viem 2.x) that runs three loops in one process:

| Module | Status after live test | What it really does |
|---|---|---|
| `listener.ts` | Working (fixed) | Watches Uniswap V2/V3 (ETH) and Uniswap V3 + Aerodrome (Base) factory events; watches Transfer logs into watchlist wallets. |
| `filter.ts` | Working | Per token: DexScreener market data, honeypot.is simulation, LP-burn heuristic (V2 only), explorer verification, deployer profile. Verdict PASS / WARN / REJECT. |
| `gold_rwa.ts` | Working live | PAXG + XAUt DEX price vs spot gold, level-change alerts. Verified live: PAXG -0.39%, XAUT -0.38% vs spot. |
| `notifier.ts` | Working | Telegram / generic webhook / stdout dispatch. |
| `api.ts` + `store.ts` | Working | Read-only JSON API :8787 — `/api/health`, `/api/gold`, `/api/whales`, `/api/pools`, optional Bearer auth, CORS. In-memory only. |
| systemd deploy | Not tested here | `deploy/` unit + install script, documented for RPi4. |

**Verified live:** npm install OK, `npm run gold` OK, all 4 factory watchers up, API endpoints OK, `tsc --noEmit` clean after fix.

**Bugs found and fixed** (PR https://github.com/Dawe583/crypto-tracker/pull/1):
- `eth.llamarpc.com` default RPC is dead (SSL 525) → replaced with `ethereum-rpc.publicnode.com`.
- `TS2719` typecheck error on viem 2.58 → cast fix.
- Public HTTP RPCs evict filters → watcher now resubscribes instead of erroring forever.

**The honest gap: this repo is a monitor, not a trader.** It detects events and sends alerts. It has no strategy engine, no order execution, no position/risk management, no backtesting, no persistent database, no real wallet private-key handling. That is ~80 % of a trading system missing.

What it is genuinely good for: a low-footprint signal/intelligence layer on the Pi (whales, new pools, gold-RWA spreads) that can feed a separate executor. `alerts -> webhook` is already a usable integration seam.

## Part 2: Open-source landscape (5k+ stars, checked 2026-11-23)

### Autonomous trading bots

| Repo | Stars | Lang | What it is | RPi4 fit |
|---|---|---|---|---|
| [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | 57.2k | Python | The reference crypto bot: strategies, dry-run paper mode, backtesting, hyperopt, FreqAI (ML), edge sizing, Telegram, web UI, ~20+ CEXs via ccxt incl. **Binance/OKX testnet paper trading** | Best. Official ARM64 Docker images; documented RPi install. |
| [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) | 21.4k | Python | Market-making & arbitrage framework, CEX+DEX connectors, scripts/v2 strategies | Powerful but heavy; realistic on 4 GB+ Pi with Docker. |
| [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | 31.8k | Rust/Py | Production-grade event-driven engine, backtest=live parity | Pro-grade, heavier learning curve; runs on ARM64. |
| [jesse-ai/jesse](https://github.com/jesse-ai/jesse) | 8.8k | Python | Cleaner strategy framework, candle-driven, spot+futures, paper trading, backtest+live | Good on RPi; fewer exchanges than freqtrade. |
| [Drakkar-Software/OctoBot](https://github.com/Drakkar-Software/OctoBot) | 7.0k | Python | Grid, DCA, AI and TradingView strategies, built-in paper trading | Light enough for RPi; good middle ground. |
| [Superalgos/Superalgos](https://github.com/Superalgos/Superalgos) | 5.8k | JS | Visual node-based trading platform, community trading intelligence | Heaviest UI approach; 4 GB+ Pi needed. |
| [chrisleekr/binance-trading-bot](https://github.com/chrisleekr/binance-trading-bot) | 5.6k | TS | Binance-only grid-style bot, pluggable strategies, backtest | Binance only; lightweight Node. |
| [ccxt/binance-trade-bot](https://github.com/ccxt/binance-trade-bot) | 8.8k | Python | Auto coin-to-coin rotation on Binance | Narrow scope (portfolio rotation, not TA trading). |

### Signal / analysis (same category as crypto-tracker)

- [CryptoSignal/Crypto-Signal](https://github.com/CryptoSignal/Crypto-Signal) 5.7k Python — TA signal engine → Telegram/Discord/webhook. Closest mature analogue; last meaningful push mid-2024 (stale but usable patterns).
- [Mathieu2301/TradingView-API](https://github.com/Mathieu2301/TradingView-API) 5.9k JS — TradingView data/indicators without a key.
- tradingview-mcp servers (5.3k, 7.3k) — wire chart/screening data into LLM agents.

### LLM / agent trading frameworks (the "X/Twitter" category)

| Repo | Stars | Note |
|---|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | 123.6k | Multi-agent LLM framework (analyst/researcher/trader/risk roles), research-grade, mostly equities — execution is your job. |
| [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader) | 23.4k | "100% automated" agent trading; research project, not a hardened executor. |
| [NoFxAiOS/nofx](https://github.com/NoFxAiOS/nofx) | 13.3k | AI trading terminal (Go), crypto support. |
| [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger) | 13.9k | Self-hosted "agentic trading OS" — AI research + backtest + trade. |
| [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice) | 7.5k | One-person Wall Street agent, equities + crypto. |

Reality check: the viral "autonomous AI traders" are mostly LLM wrappers on top of a real executor — the LLM decides, but something like freqtrade/ccxt must still place orders and manage risk.

### Backtest / research engines

- [polakowo/vectorbt](https://github.com/polakowo/vectorbt) 9.9k — vectorized backtesting, fastest research iteration.
- [kernc/backtesting.py](https://github.com/kernc/backtesting.py) 9.3k — simple and clean.
- [mementum/backtrader](https://github.com/mementum/backtrader) 23.8k — classic, unmaintained since 2024.
- [QuantConnect/Lean](https://github.com/QuantConnect/Lean) 22.7k — full engine, but oriented to their cloud; overkill for a Pi.
- [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading) 22k — reference implementations for ML strategies.

### Execution plumbing

- [ccxt/ccxt](https://github.com/ccxt/ccxt) 45k — unified API for 100+ exchanges; the library nearly every bot uses. Any custom executor built in crypto-tracker should use it (or viem for DEX swaps directly, which the repo already knows).

## Part 2b: Verified real-world results (checked 2026-11-23)

The user asked whether any of these projects publish actual results — profits people really made. Here is what verifiable evidence exists, not marketing:

**"Jev" is real — TypeSafe AI's decision model (released 2026-09-15).** It is not a chatbot: market state in, typed decisions out in ~80-400 ms. That is what the viral "AI trades every few hundred milliseconds" videos use. The reference bot is [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader) (3.1k): one buy/sell decision per Monad block (~300 ms) on the Kuru MON-USDC order book, post-only maker orders, dry-run by default, live PnL dashboard — the example event in its own README shows `pnlUsd: -0.003`. A public survey of ~15 Jev finance bots ([apex-logic](https://www.apex-logic.net/news/jev-trading-bots-github-2026)) concludes: **none has shown lasting profits yet**.

**The only rigorous published real-money test lost money.** [imikerussell/beebots](https://github.com/imikerussell/beebots) — three bots on OKX perps, decisions by Jev, then Claude Opus 5.5 rewriting rules hourly, then Gemini 4 Argon — **-21.4% in 30 days on real money** ($999 → $785.16, plus $42.35 in AI calls). Best day was day one; 40% win rate; -13.3% with Jev picking trades, -9.3% more while the "smarter" AI rewrote rules, then +$0.22 after the rebuild. Control: 35% of 200,000 coin-flip bots made a profit on the same window. Full write-up: [creatormagic.ai/blog/do-ai-trading-bots-work](https://creatormagic.ai/blog/do-ai-trading-bots-work/). The author ran the same experiment earlier with OpenClaw agents: +$100 gross, net loss after ~$530/mo in API costs.

**freqtrade: most free strategies lose; none beat holding.** A Nov-2026 independent test ran all 41 free community strategies identically (2y, Binance spot): 15 made money, 26 lost, median -22%, best +126.5% — while just holding BTC returned +288%. And backtests overstate live results: [freqtrade issue #477](https://github.com/freqtrade/freqtrade/issues/477) measured the same strategy live vs backtest over 11 days — production made ~5.5x less profit than the backtest implied.

**LLM agent frameworks (TradingAgents 124k, AI-Trader 23k, nofx 13k):** research-grade backtest machinery and live-leaderboard features, but every published number is a backtest or paper-trade; their own disclaimers say performance varies and is not advice. No verifiable live-money track records.

**Bottom line on the viral claims:** the architecture in those videos (fast decision model + code risk layer + paper default) is real and buildable. The profit claims are not — the one controlled, live-streamed, real-money experiment in this whole category lost 21% in a month and was beaten by literal coin flips. Speed of decision (~300 ms) is not the scarce resource; signal edge is.

## Part 3: Recommended architecture for the RPi4 system

Two-layer split that keeps crypto-tracker useful instead of rewriting it:

```
RPi4 (Docker, 4 GB+ recommended)
├── crypto-tracker  ── signals: whale buys, new safe pools, gold spread
│      └── webhook ───────────────┐
├── freqtrade (dry-run)           │  execution engine: strategy, sizing,
│   ├── exchange testnet API      │  stops, paper wallet, Telegram control
│   └── custom strategy module ◄──┘  consumes crypto-tracker signals
└── (optional) vectorbt research  strategy dev + backtests
```

Path to live money:
1. Week 0: merge PR #1; on the Pi run tracker + `freqtrade create-config` in `dry_run`, connect exchange **testnet** keys (Binance testnet or Bybit demo) — real order book, zero money.
2. Weeks 1-4: paper phase. Run 2-3 stock strategies + one that consumes tracker signals via webhook. Judge on real fills, fees, slippage — not vibes.
3. Go-live: smallest possible size, real API keys with **trade-only permission, withdrawals disabled**, `max_open_trades` and `stoploss` hard limits, Telegram kill-switch.

Hard truths (worth repeating):
- No public repo will "just earn money". Edge comes from your strategy, execution quality, and fees. Most retail bots lose to fees/slippage.
- Fast minute-scale trading on an RPi4 is viable for CEX via ccxt/freqtrade, not for on-chain sniping — that game is MEV infrastructure (searcher bundles, private RPC), a different and much deeper rabbit hole.
- If you want the Jev-style fast loop specifically: the proven pattern is a typed decision model making narrow calls inside hard-coded risk limits (see `jarrodwatts/jev-trader` for the reference implementation, or `imikerussell/beebots` for a documented OKX loop). Decide fast, risk-limit in code, paper first — and note that even the best-documented version of this lost money in live testing.
- Keep API keys out of `.env` on any shared machine; the systemd unit already supports an env file — use it with 600 perms.
