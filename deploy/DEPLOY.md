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
rsync -avz --exclude node_modules --exclude .env --exclude 'data/*_state.json' --exclude 'data/signal_state.json.tmp' \
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
- Back up `data/gold_state.json` and `data/signal_state.json` to retain gold alert levels and recent daemon alerts.
- Keep `.env` at `chmod 600`. It holds bot tokens and API keys.

# Vercel paper engine and deck

Use the existing Vercel project and a dedicated Supabase project. Supabase
Cron calls the Vercel function every minute, including on Vercel Hobby.
The runner uses public exchange candles and simulated fills only. It does not
start the chain listener or Gold RWA monitor, or offer a remote stop action.

1. Apply the checked-in Supabase migration using the authorized database
   release workflow (or `supabase db push` against the linked project).
2. In **Production** on Vercel, set the server-only variables:

   | Variable | Purpose |
   | --- | --- |
   | `SUPABASE_URL` | Supabase project HTTPS origin |
   | `SUPABASE_SECRET_KEY` | Supabase server-side `sb_secret_…` key |
   | `CRON_SECRET` | Random bearer secret shared only with Supabase Cron |
   | `API_TOKEN` | Different random token given to authorized deck viewers |

   Leave `ENGINE_API_ORIGIN` unset for the same-deployment reads. Do not
   copy production credentials into Preview or into the static deck.
3. Deploy through the project's release workflow. Keep the production cron
   URL reachable from Supabase; the endpoint checks its own bearer token.
4. In Supabase, enable [Cron](https://supabase.com/docs/guides/cron/quickstart)
   and [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net).
   In [Vault](https://supabase.com/docs/guides/database/vault), add
   `paper_engine_cron_url` (the production HTTPS URL ending in
   `/api/cron/paper-engine`) and `paper_engine_cron_secret` (the same value as
   `CRON_SECRET`). Run [the scheduling SQL](../supabase/schedule-paper-engine.sql)
   as the database administrator. Never paste the bearer secret into SQL
   Editor or job definitions.
5. Confirm a 200 response with `committed: true` in the `pg_net` responses
   or a fresh authenticated snapshot with a recent `cycleAt`. Confirm the
   deck leaves demo mode after entering its separate read token. A successful
   Cron job alone means the HTTP request was queued, not that the engine
   committed.

Postgres commits the position and risk checkpoint, deck snapshot and ledger
batch together; an overlapping job cannot append to an old head. Check the
Vercel function logs if the snapshot stops updating. The deck falls back
to labeled demo data when there is no first cycle or the last cycle is more
than five minutes old. Monitor Supabase database growth: the paper ledger
is append-only and is not automatically pruned.
