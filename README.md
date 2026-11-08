# Base & EVM Whale Tracker

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![viem](https://img.shields.io/badge/viem-2.x-000000)](https://viem.sh/)
[![Platform](https://img.shields.io/badge/Raspberry%20Pi-4-C51A4A?logo=raspberrypi&logoColor=white)](https://www.raspberrypi.com/)
[![systemd](https://img.shields.io/badge/systemd-auto--start-222222)](https://systemd.io/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#license)

A always-on monitor for Base (chain 8453) and Ethereum mainnet. It watches smart-money and VC wallets, detects new Uniswap V2/V3 and Aerodrome pools, runs basic token safety checks, and tracks how PAXG and XAUt trade on DEXs against spot gold. Alerts go to Telegram, a generic webhook, or stdout.

> Not financial advice. Honeypot, DexScreener, and explorer data are third-party heuristics, not guarantees.

## Contents
- [Features](#features)
- [Architecture](#architecture)
- [Hardware requirements (Raspberry Pi 4)](#hardware-requirements-raspberry-pi-4)
- [Quick start on Raspberry Pi](#quick-start-on-raspberry-pi)
- [systemd auto-start](#systemd-auto-start)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Alerts](#alerts)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Features

| Module | What it does |
|---|---|
| Whale watch | Transfer logs into watched wallets on Base and Ethereum. Alerts when a buy exceeds `WHALE_MIN_USD`. |
| New pools | Subscribes to factory events (Uniswap V3, Uniswap V2 on Ethereum, Aerodrome on Base). Filters by liquidity and safety. |
| Safety filter | Honeypot and tax simulation, LP burn heuristic (V2-style), explorer verification, deployer history. Returns PASS, WARN, or REJECT. |
| Gold RWA | Compares PAXG and XAUt DEX prices with a spot gold reference. Alerts on spread crossing `GOLD_ALERT_PCT` or `GOLD_MAJOR_PCT`, once per level change. |
| Alerts | Telegram, generic JSON webhook, plus stdout and structured logs. |

## Architecture

```
                 +-----------------------------+
  Base RPC  ---> |  listener.ts                |
  Eth RPC   ---> |  - factory PoolCreated/     |---+
                 |    PairCreated watchers     |   |
                 |  - watched-wallet Transfer  |   |
                 +-----------------------------+   |
                                                   v
                 +-----------------------------+  +---------------------+
  DexScreener -> |  filter.ts                  |->| notifier.ts         |--> Telegram
  honeypot.is -> |  market data, honeypot,     |  | render + dispatch   |--> Webhook
  Basescan/Eth ->|  LP lock, deployer, verify  |  | (also logs/stdout)  |--> stdout/logs
                 +-----------------------------+  +---------------------+
                                                   ^
                 +-----------------------------+   |
  Spot feed ---> |  gold_rwa.ts                |---+
  DexScreener -> |  PAXG/XAUt DEX vs spot,     |
                 |  level-change alerts        |
                 +-----------------------------+

  index.ts starts the listener and the gold loop in one process.
  wallets.ts loads data/watchlist.json. config.ts reads .env.
  State: data/gold_state.json (gold alert levels). Dedupe is in memory.
```

Key design points:
- One process, two independent loops (event listener and a polling gold loop). systemd keeps it running.
- Every signal goes through one dispatcher, so new alert sinks are a single change in `notifier.ts`.
- Alert spam is limited: pools and transfers are deduplicated in memory, and gold alerts fire only when an asset changes level.
- Transport: a WebSocket RPC (`*_RPC_WS`) is used when set, otherwise HTTP polling.

## Hardware requirements (Raspberry Pi 4)

| Item | Recommended | Notes |
|---|---|---|
| Board | Raspberry Pi 4 Model B, 2 GB or more | 2 GB is enough. 4 GB or 8 GB gives headroom. |
| OS | Raspberry Pi OS 64-bit (Bookworm or later) | 64-bit is required for current Node.js builds. |
| Node.js | 20 LTS or 22 LTS | Check with `node -v`. |
| Storage | 16 GB or more microSD, or a USB SSD | The app writes little. A USB SSD is more reliable for 24/7 use. |
| Network | Stable Ethernet or Wi-Fi | A paid WebSocket RPC (Alchemy, Infura) is advised. |
| Power | Official 5V/3A USB-C supply | Under-voltage causes random crashes. |
| Cooling | Passive heatsink or a small fan | Optional, but it keeps the board cool 24/7. |

Typical resource use: about 100 to 200 MB of RAM and low single-digit CPU percent once running. Bursts happen during event processing.

## Quick start on Raspberry Pi

Run these on the Pi.

```bash
# 1. Get the code
git clone https://github.com/Dawe583/crypto-tracker.git ~/crypto-tracker
cd ~/crypto-tracker

# 2. Install dependencies
npm i

# 3. Create your config (never commit .env)
cp .env.example .env
chmod 600 .env
nano .env          # fill in RPC URLs and alert credentials

# 4. Add verified wallet addresses to data/watchlist.json (template entries are skipped)
nano data/watchlist.json

# 5. Smoke test in the foreground (Ctrl+C to stop)
npm start

# 6. Install the systemd service (see next section)
```

If Node.js is missing, install version 20 or later first. For example, with NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

## systemd auto-start

The unit file is `deploy/whale-tracker.service`. It starts on boot, restarts after failure, and sends logs to journald.

```bash
cd ~/crypto-tracker
sudo cp deploy/whale-tracker.service /etc/systemd/system/whale-tracker.service
sudo sed -i "s|<USER>|$USER|; s|<APP_DIR>|$PWD|g" /etc/systemd/system/whale-tracker.service
which npm                    # if not /usr/bin/npm, edit ExecStart in the unit file
sudo systemctl daemon-reload
sudo systemctl enable --now whale-tracker
sudo systemctl status whale-tracker
```

Useful commands:

```bash
journalctl -u whale-tracker -f          # follow logs
journalctl -u whale-tracker --since today
sudo systemctl restart whale-tracker    # after editing .env or the watchlist
sudo systemctl stop whale-tracker
sudo systemctl disable whale-tracker    # stop auto-start on boot
```

Updating:

```bash
cd ~/crypto-tracker && git pull && npm i && sudo systemctl restart whale-tracker
```

See [deploy/DEPLOY.md](deploy/DEPLOY.md) for rsync deploys and more detail.

## Configuration

All settings come from `.env`. The template is `.env.example`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `BASE_RPC_HTTP` | No | `https://mainnet.base.org` | Base HTTP RPC, used when no WebSocket is set. |
| `BASE_RPC_WS` | Recommended | (empty) | Base WebSocket RPC, for example from Alchemy or Infura. |
| `ETH_RPC_HTTP` | No | `https://eth.llamarpc.com` | Ethereum HTTP RPC. |
| `ETH_RPC_WS` | Recommended | (empty) | Ethereum WebSocket RPC. |
| `BASESCAN_API_KEY` | No | (empty) | Enables Base source-verification checks. |
| `ETHERSCAN_API_KEY` | No | (empty) | Enables Ethereum source-verification checks. |
| `TELEGRAM_BOT_TOKEN` | No | (empty) | Bot token from BotFather. Needs `TELEGRAM_CHAT_ID` too. |
| `TELEGRAM_CHAT_ID` | No | (empty) | Chat or channel ID that receives alerts. |
| `ALERT_WEBHOOK_URL` | No | (empty) | Receives a JSON POST per signal (`{ text, signal }`). |
| `WHALE_MIN_USD` | No | `50000` | Minimum buy size (USD) to raise a whale alert. |
| `MIN_LIQUIDITY_USD` | No | `20000` | Minimum liquidity (USD) for a new-pool alert. |
| `MAX_BUY_TAX_PCT` | No | `10` | Buy tax above this value adds a WARN reason. |
| `MAX_SELL_TAX_PCT` | No | `10` | Sell tax above this value adds a WARN reason. |
| `GOLD_SPOT_URL` | No | `https://api.gold-api.com/price/XAU` | Spot gold JSON feed. Expects a numeric `price` field. |
| `GOLD_POLL_MS` | No | `60000` | Gold scan interval in milliseconds. |
| `GOLD_ALERT_PCT` | No | `0.5` | Spread (%) that triggers a gold alert. |
| `GOLD_MAJOR_PCT` | No | `1.5` | Spread (%) that triggers a major gold alert. |
| `BASE_PAXG_ADDRESS` | No | (empty) | Optional Base PAXG address. Verify on Basescan first. |
| `BASE_XAUT_ADDRESS` | No | (empty) | Optional Base XAUt address. Verify on Basescan first. |
| `LOG_LEVEL` | No | `info` | `fatal`, `error`, `warn`, `info`, `debug`, or `trace`. |

Changes to `.env` take effect after `sudo systemctl restart whale-tracker`.

## Project layout

```
crypto-tracker/
├── src/
│   ├── index.ts         # entry point: starts listener + gold loop
│   ├── config.ts        # env parsing, chain/factory config, thresholds
│   ├── listener.ts      # factory and watched-wallet event subscriptions
│   ├── filter.ts        # market data, honeypot, LP lock, verification, verdicts
│   ├── wallets.ts       # watchlist loader and lookup
│   ├── gold_rwa.ts      # PAXG/XAUt vs spot monitor
│   ├── notifier.ts      # alert rendering and dispatch (Telegram/webhook)
│   └── logger.ts        # pino logger
├── data/
│   └── watchlist.json   # wallets to watch (template shipped)
├── deploy/
│   ├── DEPLOY.md        # detailed Raspberry Pi deployment guide
│   └── whale-tracker.service  # systemd unit
├── .env.example         # configuration template (no secrets)
├── package.json
└── tsconfig.json
```

Runtime files such as `data/state.json` and `data/gold_state.json` are created on first run and are git-ignored.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the listener and the gold monitor (production entry point). |
| `npm run listen` | On-chain listener only. |
| `npm run gold` | One Gold RWA scan, printed as JSON. Useful for testing. |
| `npm run typecheck` | TypeScript type check, no output. |
| `npm run build` | Compile to `dist/`. Not required, because `npm start` runs the source through tsx. |

## Alerts

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, and/or `ALERT_WEBHOOK_URL`. With neither set, alerts print to stdout and the log.

Alert types:
- WHALE BUY: a watched wallet bought at least `WHALE_MIN_USD`.
- NEW POOL: a new pool passed the filter and the liquidity minimum. Includes a safety verdict and reasons.
- GOLD RWA SPREAD or MAJOR DEVIATION: a PAXG or XAUt spread crossed a threshold.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm i` fails with `EBADENGINE` or syntax errors | Node.js older than 20 | Install Node 20 or 22, then run `node -v`. |
| `Error: Invalid URL` or RPC connection errors | Empty or wrong `*_RPC_*` value | Check `.env`. Make sure the WebSocket URL starts with `wss://`. |
| `429` or `rate limit` in logs | Public RPC throttling event filters | Use a paid WebSocket RPC (Alchemy or Infura). |
| `watchlist loaded` with `count: 0` | Only template entries are present | Replace the `REPLACE_WITH_VERIFIED_0x_ADDRESS` entries with real addresses. |
| No gold alerts and `no spot gold reference` warnings | Spot feed unreachable or changed shape | Check `GOLD_SPOT_URL` in a browser. Set `GOLD_SPOT_URL` to a feed that returns `{ "price": number }`. |
| Telegram alerts missing | Wrong token or chat ID, or the bot was never started in the chat | Send `/start` to the bot. Check `telegram send failed` in the log. |
| `EADDRINUSE` or service exits right away | Another instance is running, or the path in the unit file is wrong | Run `sudo systemctl status whale-tracker`. Check `WorkingDirectory` and `ExecStart`. |
| Service fails with `npm: not found` | npm is not at `/usr/bin/npm` | Run `which npm` and update `ExecStart` in `/etc/systemd/system/whale-tracker.service`, then `sudo systemctl daemon-reload`. |
| Service stops after reboot | Network not up yet, or service not enabled | The unit waits for `network-online.target`. Run `sudo systemctl enable whale-tracker`. |
| Pi is slow or runs out of memory | Swap or memory pressure, usually on a 1 GB board | Use a 2 GB or larger Pi. Check with `free -h`. |
| Logs are too noisy | Log level too low | Set `LOG_LEVEL=warn` in `.env`, then restart. |

Useful diagnostics:

```bash
node -v && npm -v
npm run typecheck
npm run gold          # confirms spot and DEX data reachable
journalctl -u whale-tracker -n 200 --no-pager
```

## Limitations
- Public RPCs rate-limit `eth_newFilter` and watch calls. Use a WebSocket provider for production.
- Honeypot and DexScreener data are third-party heuristics.
- The LP lock check covers Uniswap V2-style LPs only. V3 positions are NFTs.
- The gold spread compares DEX prices with a spot reference. Redemption fees, mint fees, and slippage are not netted out.
- Dedupe state for pools and transfers is in memory, so it resets on restart.
- No watchlist addresses ship as verified. You must curate them.

## License
Private project. All rights reserved unless the owner states otherwise.
