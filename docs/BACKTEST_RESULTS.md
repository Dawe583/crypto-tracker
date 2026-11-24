# Backtest digest

> Historical artifact. These results predate next-open fills and round-trip cost accounting. They do not validate a trading edge; see the [current paper-strategy replay](PAPER_STRATEGY.md#historical-replay).

Replay of all 19 strategies through PaperPortfolio on live candles (Coinbase feed, ~240 bars each).

## 1m — 54 runs, 2 positive

| strategy | symbol | trades | win% | pnl $ | maxdd $ |
|---|---|---|---|---|---|
| zscore_reversion | ETHUSDT | 4 | 75 | 1.02 | 1.88 |
| zscore_reversion | BTCUSDT | 4 | 75 | 0.49 | 2.20 |
| breakout | BTCUSDT | 0 | 0 | 0.00 | 0.00 |
| macd_momentum | BTCUSDT | 0 | 0 | 0.00 | 0.00 |
| vol_spike | BTCUSDT | 0 | 0 | 0.00 | 0.00 |
| grid | BTCUSDT | 0 | 0 | 0.00 | 0.00 |

## 15m — 54 runs, 18 positive

| strategy | symbol | trades | win% | pnl $ | maxdd $ |
|---|---|---|---|---|---|
| ema_cross | SOLUSDT | 4 | 50 | 26.87 | 7.61 |
| breakout | SOLUSDT | 3 | 33 | 15.93 | 11.02 |
| stoch_cross | BTCUSDT | 5 | 60 | 13.83 | 2.85 |
| obv_drift | SOLUSDT | 5 | 60 | 13.70 | 3.68 |
| donchian | SOLUSDT | 3 | 33 | 10.00 | 12.35 |
| breakout | ETHUSDT | 2 | 100 | 9.71 | 10.00 |

## 1h — 54 runs, 4 positive

| strategy | symbol | trades | win% | pnl $ | maxdd $ |
|---|---|---|---|---|---|
| zscore_reversion | ETHUSDT | 8 | 62 | 14.26 | 17.43 |
| obv_drift | SOLUSDT | 2 | 100 | 4.33 | 2.89 |
| zscore_reversion | BTCUSDT | 7 | 57 | 4.06 | 21.20 |
| zscore_reversion | SOLUSDT | 5 | 40 | 0.25 | 22.05 |
| macd_momentum | BTCUSDT | 0 | 0 | 0.00 | 0.00 |
| whale_follow | BTCUSDT | 0 | 0 | 0.00 | 0.00 |

Takeaway: 15m is the signal window for this strategy set; 1m is too noisy, 1h too slow.
## Cost stress (15m, all 6 symbols) — data/stress-15m.json

pnl $ at fee x slippage; ema_cross survives every scenario, breakout fee-insensitive (few trades).

| strategy | 0.1% + 0bps | 0.1% + 5bps | 0.1% + 20bps |
|---|---|---|---|
| ema_cross | 94.4 | 90.6 | 70.8 |
| breakout | 36.7 | 34.7 | 28.8 |
| zscore_reversion | 23.9 | 21.3 | 13.3 |
| rsi_reversion | 26.9 | 20.1 | -0.2 |
| stoch_cross | 30.0 | 21.8 | -3.0 |
| obv_drift | 30.8 | 23.1 | 0.0 |

Takeaway: fast reversion strategies die at ~20bps slippage (DEX territory); trend strategies (ema_cross, breakout) keep edge — on CEX spot with ~2-3bps slip they are safe.
