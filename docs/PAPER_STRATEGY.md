# Paper strategy: MACD/Bollinger reversal

## Open-source systems evaluated

| System | Relevant feature | Fit here |
|---|---|---|
| [Hummingbot](https://github.com/hummingbot/hummingbot) (Apache-2.0) | Directional controllers and position executors | Adapted the [MACD/Bollinger conditions](https://github.com/hummingbot/hummingbot/blob/3351adad0a09f6a57a202219d3e52fe794672421/controllers/directional_trading/macd_bb_v1.py) and used its [triple-barrier exit design](https://github.com/hummingbot/hummingbot/blob/3351adad0a09f6a57a202219d3e52fe794672421/hummingbot/strategy_v2/executors/position_executor/data_types.py); no exchange executor. |
| [Jesse](https://github.com/jesse-ai/jesse) (MIT) | Backtesting and [fee-aware stop-risk sizing](https://github.com/jesse-ai/jesse/blob/5b97b13ae6e40168b7f119b6c75d965e81add92c/jesse/utils.py) | Adapted its risk formula to capped USD notional and adverse stop slippage; no Python service. |
| [Freqtrade](https://github.com/freqtrade/freqtrade) (GPL-3.0) | Dry-run, backtesting, [closed signal → next-open fill](https://github.com/freqtrade/freqtrade/blob/7fcb509a434cfaa5e0943a7ccc005967cfd0b9d9/docs/strategy-customization.md) and [lookahead analysis](https://github.com/freqtrade/freqtrade/blob/7fcb509a434cfaa5e0943a7ccc005967cfd0b9d9/docs/lookahead-analysis.md) | Followed the replay convention; no GPL code reused. |
| [OpenTrader](https://github.com/Open-Trader/opentrader) (Apache-2.0) | TypeScript paper trading, backtests, and grid/DCA/RSI strategies | Closest stack match, but designed to be self-hosted. We do not need a second bot, database, or UI. |

Hummingbot Foundation and Jesse.Trade license notices: [Apache-2.0](HUMMINGBOT-LICENSE.txt), [MIT](JESSE-LICENSE.txt). The controller is a TypeScript spot-long adaptation, not an exact Hummingbot runtime. It uses the configured market interval (one minute by default, versus upstream's three), local indicators, and our own risk and execution rules. Hummingbot's short entry is an exit signal here; it never opens a short.

## Forward paper behavior

1. Evaluate the last 120 fresh, contiguous **closed** candles once per symbol and candle; the timestamp survives a cron restart. Enter when price is below the 100-period lower Bollinger band and MACD(21, 42, 9) has a positive histogram but a negative line. No stacking on an already-held symbol.
2. Set a volatility stop at 2.5× ATR(14), with a 0.6% floor; skip if this needs more than 3%. Allocate up to 0.25% of paper equity to estimated stop loss, including fees and modeled slippage, within the existing cash, position, exposure and daily-loss limits. Gaps can exceed this budget; it is not a guarantee.
3. Close on stop, target at twice the initial stop distance, an opposite signal, or after 180 minutes. A trailing stop follows favorable **observed** marks once the initial stop distance is earned. The high-water mark survives a cron restart. Fills use the observed mark plus adverse slippage of 3 basis points per side, and actual simulated fees on both legs. No intrabar trigger or order-book fill is assumed.

This is the only default strategy for **new paper entries**. Previously opened positions keep their existing stops and can still exit under their original strategies. The deployment, cadence, Supabase schema, credentials, and disabled hosted Stop control are unchanged. The cron can observe only periodic public marks; it does not send exchange orders. Historical ledger records are not rewritten; entry fees for old positions without an entry-fee field are not guessed.

## Historical replay

Data: checksum-verified [Binance spot archive](https://data.binance.vision/?prefix=data/spot/monthly/klines/) for July–September 2025. Each pair and time block starts with its own $10,000 paper wallet. Settings were not fitted to those blocks. The strategy sees only earlier bars, fills at the next bar's open, and checks exits against sampled opens. All rows assume 0.10% per side plus 3 bps adverse slippage; P&L includes fees. The full portfolios and live execution are not simulated.

| Pair | Jul–Aug MACD/BB trades / net | Sep MACD/BB trades / net | Sep EMA cross net | Sep breakout net | Sep MACD/BB higher-cost net |
|---|---:|---:|---:|---:|---:|
| BTCUSDT | 59 / −$121.91 | 27 / −$36.27 | −$230.51 | −$34.08 | −$79.96 |
| ETHUSDT | 67 / −$120.64 | 36 / −$63.70 | −$321.83 | −$84.41 | −$110.03 |
| SOLUSDT | 69 / −$55.71 | 28 / −$37.78 | −$247.01 | −$29.89 | −$81.16 |

Higher-cost case: 0.20% fee plus 10 bps slippage per side. The no-trade baseline ($0 P&L) beat the candidate in both one-minute blocks. Exploratory 3-, 5- and 15-minute aggregates also lost on all three pairs in September and did not justify switching the hosted interval. **The execution model is improved; the tested signal has no demonstrated profitable edge.** Keep it paper-only for observation; evaluate a genuinely different candidate with new holdout data before increasing simulated exposure or considering a different mandate.

## Reproduce the September base comparison

```sh
symbol=BTCUSDT # also ETHUSDT or SOLUSDT
file="$symbol-1m-2025-09.zip"
base="https://data.binance.vision/data/spot/monthly/klines/$symbol/1m"
curl -fsSLO "$base/$file"
curl -fsSLO "$base/$file.CHECKSUM"
sha256sum -c "$file.CHECKSUM"
unzip -p "$file" > "/tmp/$symbol-september.csv"
TZ=UTC npm run backtest -- "$symbol" 1m "/tmp/$symbol-september.csv" macd_bb_v1,ema_cross,breakout
```

For the July–August block, concatenate the verified July and August CSVs in order. The higher-cost case calls `replayOne` with `feePct=0.2`, `slipBps=10`, and `barMs=60000`. The replay intentionally ignores partial fills, exchange/source switches, intraminute stops, latency differences, and correlation across symbols.
