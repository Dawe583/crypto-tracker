# Raspberry Pi 4 deployment guide

This guide covers deploying crypto-tracker (base-evm-whale-tracker) on a Raspberry Pi 4 with systemd auto-start. The README has a shorter version.

## 1. Prerequisites

- Raspberry Pi 4 (2 GB or more) running Raspberry Pi OS 64-bit.
- Node.js 20 or later (`node -v`). Install with NodeSource or nvm.
- git (`sudo apt-get install -y git`).

## 2. Get the code

Option A, git:
```bash
git clone https://github.com/Dawe583/crypto-tracker.git ~/crypto-tracker
cd ~/crypto-tracker
```

Option B, rsync from a workstation (excludes local secrets and state):
```bash
rsync -avz --exclude node_modules --exclude .env --exclude 'data/*_state.json' \
  ./crypto-tracker/ <USER>@<PI_HOST>:/home/<USER>/crypto-tracker/
```

## 3. Install dependencies
```bash
npm i
```
devDependencies are needed because `npm start` runs TypeScript through tsx.

## 4. Configure
```bash
cp .env.example .env
chmod 600 .env
nano .env
```
Fill in the RPC WebSocket URLs, Telegram credentials, and any optional keys. See the README configuration table.

Edit `data/watchlist.json` with verified addresses. Template entries are skipped.

Verify factory and token addresses in `src/config.ts` and `src/gold_rwa.ts` on the block explorer.

## 5. Smoke test
```bash
npm start
```
Look for the startup line `Base & EVM whale tracker running`. Stop with Ctrl+C.

## 6. Install the systemd service
```bash
cd ~/crypto-tracker
sudo cp deploy/whale-tracker.service /etc/systemd/system/whale-tracker.service
sudo sed -i "s|<USER>|$USER|; s|<APP_DIR>|$PWD|g" /etc/systemd/system/whale-tracker.service
which npm   # if not /usr/bin/npm, edit ExecStart in the unit file
sudo systemctl daemon-reload
sudo systemctl enable --now whale-tracker
sudo systemctl status whale-tracker
```

## 7. Operate
```bash
journalctl -u whale-tracker -f                 # live logs
journalctl -u whale-tracker --since today      # today's logs
sudo systemctl restart whale-tracker           # after config changes
sudo systemctl stop whale-tracker
sudo systemctl disable whale-tracker           # no auto-start on boot
```

## 8. Update
```bash
cd ~/crypto-tracker && git pull && npm i && sudo systemctl restart whale-tracker
```

## Notes
- Public RPCs rate-limit event filters. For reliable operation, set `BASE_RPC_WS` and `ETH_RPC_WS` to a WebSocket provider.
- `npm run build` writes `dist/`, but the service does not need it.
- `data/state.json` and `data/gold_state.json` are runtime files. Back them up if you want to keep dedupe and gold-level state.
- Keep `.env` at `chmod 600`. It holds bot tokens and API keys.
