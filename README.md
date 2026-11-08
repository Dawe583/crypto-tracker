# Base & EVM Whale Tracker

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![viem](https://img.shields.io/badge/viem-2.x-000000)](https://viem.sh/)
[![Platform](https://img.shields.io/badge/Raspberry%20Pi-4-C51A4A?logo=raspberrypi&logoColor=white)](https://www.raspberrypi.com/)
[![systemd](https://img.shields.io/badge/systemd-auto--start-222222)](https://systemd.io/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#license)

A always-on monitor for Base (chain 8453) and Ethereum mainnet. It watches smart-money and VC wallets, detects new Uniswap V2/V3 and Aerodrome pools, runs basic token safety checks, and tracks how PAXG and XAUt trade on DEXs against spot gold. Alerts go to Telegram, a generic webhook, or stdout. A small HTTP JSON API exposes health, gold, whale, and pool data.

> Not financial advice. Honeypot, DexScreener, and explorer data are third-party heuristics, not guarantees.

## Contents
- [Features](#features)
- [Architecture](#architecture)
- [Hardware requirements (Raspberry Pi 4)](#hardware-requirements-raspberry-pi-4)
- [Quick start on Raspberry Pi](#quick-start-on-raspberry-pi)
- [systemd auto-start](#systemd-auto-start)
- [HTTP JSON API](#http-json-api)
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
| HTTP JSON API | Read-only endpoints for health, gold, whales, and pools on port 8787. See [HTTP JSON API](#http-json-api). |

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

                 +-----------------------------+
  store.ts ----> |  api.ts                     |--> HTTP JSON API (port 8787)
                 |  /api/health, /api/gold,    |
                 |  /api/whales, /api/pools    |
                 +-----------------------------+

  index.ts starts the listener, the gold loop, and the API in one process.
  wallets.ts loads data/watchlist.json. config.ts reads .env.
  store.ts holds the recent data that the API serves.
  State: data/gold_state.json (gold alert levels). Dedupe is in memory.
```

Key design points:
- One process, independent loops (event listener and a polling gold loop) plus the optional API server. systemd keeps it running.
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

Run these on the Pi. The full step-by-step guide is [docs/RPI4_DEPLOYMENT.md](docs/RPI4_DEPLOYMENT.md).

```bash
# 1. Get the code
git clone https://github.com/Dawe583/crypto-tracker.git ~/crypto-tracker
cd ~/crypto-tracker

# 2. Install dependencies
npm i

# 3. Create your config (never commit .env)
cp .env.example .env
chmod 600 .env
nano .env          # fill in RPC URLs, alert credentials, and API_TOKEN

# 4. Add verified wallet addresses to data/watchlist.json (template entries are skipped)
nano data/watchlist.json

# 5. Smoke test in the foreground (Ctrl+C to stop)
npm start

# 6. Install the systemd service (see next section)
sudo bash deploy/install-service.sh
```

If Node.js is missing, install version 20 or later first. For example, with NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

## systemd auto-start

The recommended way to install the service is the helper script `deploy/install-service.sh`, run from the repo root on the Pi. Read the script first and check the paths it uses. The step-by-step procedure is in [docs/RPI4_DEPLOYMENT.md](docs/RPI4_DEPLOYMENT.md).

```bash
cd ~/crypto-tracker
sudo bash deploy/install-service.sh
```

The unit file is `deploy/whale-tracker.service`. It starts on boot, restarts after failure, and sends logs to journald. To install it by hand instead:

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

See [docs/RPI4_DEPLOYMENT.md](docs/RPI4_DEPLOYMENT.md) for the full Raspberry Pi deployment guide, and [deploy/DEPLOY.md](deploy/DEPLOY.md) for rsync deploys and more detail.

## HTTP JSON API

The tracker process serves a read-only JSON API from `src/api.ts`, backed by the in-memory data in `src/store.ts`. It is enabled by default and listens on port 8787. Set `API_HOST=127.0.0.1` for local-only access, or `0.0.0.0` (the default in `.env.example`) for LAN access.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | Service health and status. Use it to check that the tracker is running. |
| GET | `/api/gold` | Latest PAXG and XAUt DEX prices compared with the spot gold reference. |
| GET | `/api/whales` | Recent watched-wallet buy activity. |
| GET | `/api/pools` | Recently detected new pools and their filter results. |

Example:

```bash
curl http://<pi-address>:8787/api/health
```

Access control:
- If `API_TOKEN` is set, protect the API with it. Generate a value with `openssl rand -hex 32`. The exact header or query scheme is defined in `src/api.ts`.
- Set `API_TOKEN` whenever the Pi is reachable beyond localhost.
- Browser access is allowed from `openterminal-ashen.vercel.app` and localhost by default. Add more origins with `API_CORS_ORIGINS`.
- To disable the API, set `API_ENABLED=false` and restart the service.

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

HTTP API settings:

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_ENABLED` | No | `true` | Set to `false` to turn off the HTTP JSON API. |
| `API_HOST` | No | `0.0.0.0` | Bind address. `0.0.0.0` allows LAN access. `127.0.0.1` allows local access only. |
| `API_PORT` | No | `8787` | Port for the HTTP JSON API. |
| `API_TOKEN` | Recommended | (empty) | Access token for the API. Generate with `openssl rand -hex 32`. Required if the Pi is reachable beyond localhost. |
| `API_CORS_ORIGINS` | No | (empty) | Extra browser origins for CORS, comma-separated. `openterminal-ashen.vercel.app` and localhost are built in. |

Changes to `.env` take effect after `sudo systemctl restart whale-tracker`.

## Project layout

```
crypto-tracker/
├── src/
│   ├── index.ts         # entry point: starts listener, gold loop, and API
│   ├── config.ts        # env parsing, chain/factory config, thresholds
│   ├── listener.ts      # factory and watched-wallet event subscriptions
│   ├── filter.ts        # market data, honeypot, LP lock, verification, verdicts
│   ├── wallets.ts       # watchlist loader and lookup
│   ├── gold_rwa.ts      # PAXG/XAUt vs spot monitor
│   ├── store.ts         # in-memory store of recent gold, whale, and pool data
│   ├── api.ts           # HTTP JSON API (/api/health, /api/gold, /api/whales, /api/pools)
│   ├── notifier.ts      # alert rendering and dispatch (Telegram/webhook)
│   └── logger.ts        # pino logger
├── data/
│   └── watchlist.json   # wallets to watch (template shipped)
├── deploy/
│   ├── install-service.sh     # installs the systemd service on the Pi
│   ├── whale-tracker.service  # systemd unit
│   └── DEPLOY.md        # rsync and deploy notes
├── docs/
│   └── RPI4_DEPLOYMENT.md     # detailed Raspberry Pi deployment guide
├── .env.example         # configuration template (no secrets)
├── package.json
└── tsconfig.json
```

Runtime files such as `data/state.json` and `data/gold_state.json` are created on first run and are git-ignored.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the listener, the gold monitor, and the HTTP API (production entry point). |
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
| `EADDRINUSE` or service exits right away | Another instance is running (including one on port 8787), or the path in the unit file is wrong | Run `sudo systemctl status whale-tracker`. Check `WorkingDirectory` and `ExecStart`. Change `API_PORT` if 8787 is taken. |
| API unreachable from another machine | `API_HOST` set to `127.0.0.1`, or a firewall blocks port 8787 | Set `API_HOST=0.0.0.0`, restart the service, and check the firewall. |
| API returns unauthorized | `API_TOKEN` is set but the request does not send it | Send the token using the scheme in `src/api.ts`. |
| Browser requests blocked by CORS | Origin not in the built-in list | Add the origin to `API_CORS_ORIGINS` and restart. |
| Service fails with `npm: not found` | npm is not at `/usr/bin/npm` | Run `which npm` and update `ExecStart` in `/etc/systemd/system/whale-tracker.service`, then `sudo systemctl daemon-reload`. |
| Service stops after reboot | Network not up yet, or service not enabled | The unit waits for `network-online.target`. Run `sudo systemctl enable whale-tracker`. |
| Pi is slow or runs out of memory | Swap or memory pressure, usually on a 1 GB board | Use a 2 GB or larger Pi. Check with `free -h`. |
| Logs are too noisy | Log level too low | Set `LOG_LEVEL=warn` in `.env`, then restart. |

Useful diagnostics:

```bash
node -v && npm -v
npm run typecheck
npm run gold          # confirms spot and DEX data reachable
curl http://localhost:8787/api/health   # confirms the API is up
journalctl -u whale-tracker -n 200 --no-pager
```

## Limitations
- Public RPCs rate-limit `eth_newFilter` and watch calls. Use a WebSocket provider for production.
- Honeypot and DexScreener data are third-party heuristics.
- The LP lock check covers Uniswap V2-style LPs only. V3 positions are NFTs.
- The gold spread compares DEX prices with a spot reference. Redemption fees, mint fees, and slippage are not netted out.
- Dedupe state for pools and transfers is in memory, so it resets on restart. The API data in `src/store.ts` is also in memory and resets on restart.
- No watchlist addresses ship as verified. You must curate them.

## License
Private project. All rights reserved unless the owner states otherwise.
