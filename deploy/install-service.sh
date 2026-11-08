#!/usr/bin/env bash
# Installs and starts the whale-tracker systemd service for the current checkout.
# Usage: cd ~/crypto-tracker && bash deploy/install-service.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
NPM_BIN="$(command -v npm || true)"

if [ -z "$NPM_BIN" ]; then
  echo "npm not found. Install Node.js 20+ first (see docs/RPI4_DEPLOYMENT.md)." >&2
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "Missing $APP_DIR/.env. Run: cp .env.example .env && chmod 600 .env && nano .env" >&2
  exit 1
fi

chmod 600 "$APP_DIR/.env"
(cd "$APP_DIR" && npm install --no-audit --no-fund)

TMP_UNIT="$(mktemp)"
sed -e "s|<USER>|$RUN_USER|g" \
    -e "s|<APP_DIR>|$APP_DIR|g" \
    -e "s|^ExecStart=.*|ExecStart=$NPM_BIN start|" \
    "$APP_DIR/deploy/whale-tracker.service" > "$TMP_UNIT"

sudo install -m 644 "$TMP_UNIT" /etc/systemd/system/whale-tracker.service
rm -f "$TMP_UNIT"
sudo systemctl daemon-reload
sudo systemctl enable --now whale-tracker
sleep 3
sudo systemctl --no-pager status whale-tracker || true

API_PORT="$(grep -E '^API_PORT=' "$APP_DIR/.env" | cut -d= -f2- || true)"
API_PORT="${API_PORT:-8787}"
echo
echo "Installed. Verify the API with: curl -s http://127.0.0.1:${API_PORT}/api/health"
