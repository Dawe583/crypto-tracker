# Raspberry Pi 4 deployment and OpenTerminal integration

The tracker runs as one Node.js process (src/index.ts) that starts three parts together:
- src/listener.ts: new pools (factory events) and whale transfers on Base and Ethereum
- src/gold_rwa.ts: PAXG and XAUt DEX price vs spot gold, polled every GOLD_POLL_MS
- src/api.ts: JSON API on API_PORT (default 8787) that reads the in-memory store in src/store.ts

All alerts go through src/notifier.ts, which logs, sends Telegram or webhook, and records the signal for the API. The API store resets on restart. Gold alert levels persist in data/gold_state.json.

## 1. Prerequisites on the Pi

Raspberry Pi OS 64-bit, Node.js 20 or 22, git.

  node -v && git --version

If Node is missing:

  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git

## 2. One-liner setup

Clone and create the config file:

  git clone https://github.com/Dawe583/crypto-tracker.git ~/crypto-tracker && cd ~/crypto-tracker && cp .env.example .env && chmod 600 .env && nano .env

Fill in at least BASE_RPC_WS and ETH_RPC_WS (WebSocket RPC from Alchemy or Infura), TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, and API_TOKEN (generate with openssl rand -hex 32).

Install the systemd service and start it:

  cd ~/crypto-tracker && bash deploy/install-service.sh

The script runs npm install, writes the unit to /etc/systemd/system/whale-tracker.service with your user, the app path, and the npm path, then runs daemon-reload and enable --now.

## 3. Verify

  systemctl is-enabled whale-tracker     # enabled
  systemctl is-active whale-tracker      # active
  journalctl -u whale-tracker -f         # live logs
  curl -s http://127.0.0.1:8787/api/health
  curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8787/api/gold

Boot test: sudo reboot, then systemctl is-active whale-tracker.

Update: cd ~/crypto-tracker && git pull && npm install && sudo systemctl restart whale-tracker

Stop or disable: sudo systemctl stop whale-tracker; sudo systemctl disable whale-tracker

The service uses Restart=always with StartLimitIntervalSec=0, so it keeps retrying after crashes. It starts after network-online.target and loads .env through EnvironmentFile.

## 4. API settings (.env)

API_ENABLED (default true), API_HOST (default 0.0.0.0; use 127.0.0.1 for local only), API_PORT (default 8787), API_TOKEN (if set, all /api/* routes except /api/health need Authorization: Bearer <token>), API_CORS_ORIGINS (extra comma-separated origins).

After any .env change: sudo systemctl restart whale-tracker

## 5. Endpoints

GET /api/health: status, uptime, watched wallet count, last gold scan time, signal counts. Never requires auth.
GET /api/gold: stale flag, thresholds, and per asset: symbol, chain, dexPriceUsd, spotUsd, deviationPct, level, direction, liquidityUsd, pairUrl.
GET /api/whales?limit=50: latest whale buy signals, newest first (limit 1 to 200).
GET /api/pools?limit=50: latest new-pool signals with safety verdict, reasons, contractVerified, liquidityUsd, marketCapUsd, links.

Responses are JSON with Cache-Control: no-store. Only GET and OPTIONS are supported. Gold refreshes every GOLD_POLL_MS (default 60 seconds), so poll no faster than that. Whales and pools poll every 30 to 60 seconds. Signals only exist since the last restart.

## 6. CORS and connecting OpenTerminal

CORS allows https://openterminal-ashen.vercel.app, any http://localhost or http://127.0.0.1 origin on any port, and origins in API_CORS_ORIGINS.

Browsers block HTTPS pages from calling plain http endpoints (mixed content). Pick one:
- Local dashboard on the same LAN: run OpenTerminal on localhost and call http://<PI_IP>:8787 directly.
- Hosted dashboard on Vercel (recommended): expose the Pi over HTTPS with Cloudflare Tunnel or Tailscale Funnel, set API_TOKEN, and call it from a Next.js route handler on the server, so the token stays in a server environment variable.

Server-side example (Next.js route handler):

  // app/api/tracker/gold/route.ts
  export async function GET() {
    const r = await fetch(`${process.env.TRACKER_URL}/api/gold`, {
      headers: { authorization: `Bearer ${process.env.TRACKER_TOKEN}` },
      cache: 'no-store',
    });
    return Response.json(await r.json(), { status: r.status });
  }

Security: the API is open on the LAN unless API_TOKEN is set. Do not port-forward 8787 on your router. CORS only restricts browsers, so use API_TOKEN for anything reachable from outside your LAN.

## 7. Custom whale wallets

Edit data/watchlist.json. Each entry needs a verified 0x address:

  [{ "address": "0xYourVerifiedAddress", "label": "Short label", "category": "smart_money", "chains": ["base", "ethereum"], "notes": "Source" }]

Categories: smart_money, vc, insider_cluster, deployer, other. Template entries without a valid address are skipped. Restart after editing: sudo systemctl restart whale-tracker.

## 8. Gold RWA and DexScreener parameters

GOLD_SPOT_URL (default https://api.gold-api.com/price/XAU; must return JSON with a numeric price field), GOLD_ALERT_PCT (default 0.5), GOLD_MAJOR_PCT (default 1.5), GOLD_POLL_MS (default 60000), BASE_PAXG_ADDRESS and BASE_XAUT_ADDRESS (optional Base tokens; verify on Basescan first). Ethereum PAXG and XAUt are built in (GOLD_ASSETS in src/gold_rwa.ts). DexScreener pairs are picked by deepest liquidity on the matching chain. Other tokens can be added by editing GOLD_ASSETS and redeploying; .env does not add arbitrary DexScreener tokens yet.

## 9. Troubleshooting

- Service failed: journalctl -u whale-tracker -n 200 --no-pager; check .env syntax and which npm.
- EADDRINUSE on 8787: set API_PORT to another value and restart.
- 401 on /api/gold: send Authorization: Bearer <API_TOKEN>. /api/health is always open.
- Browser CORS error: origin must be openterminal-ashen.vercel.app or localhost, or be listed in API_CORS_ORIGINS.
- stale: true on /api/gold: spot feed or DexScreener unreachable; check logs for no spot gold reference.
- Not starting after reboot: sudo systemctl enable whale-tracker.

## 10. Files

deploy/whale-tracker.service (systemd unit), deploy/install-service.sh (installer), deploy/DEPLOY.md (older manual notes), src/api.ts and src/store.ts (API), .env.example (all settings).
