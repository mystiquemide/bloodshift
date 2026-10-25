#!/usr/bin/env bash
# Resets the demo network: fresh synthetic stock and courier slots relative to now, an empty
# transfer history, then one real starter round so every view has something to show.
#   bash scripts/reset-demo.sh
#   STARTER=off bash scripts/reset-demo.sh   # fresh network, no transfers yet
# Under systemd (SERVICE, default bloodshift) the app is stopped and started around the reset.
# Without it, stop the app first and start it again before the starter round runs.
set -euo pipefail

cd "$(dirname "$0")/.."
SERVICE="${SERVICE:-bloodshift}"
# Read only the two settings needed here. Sourcing .env would run shell syntax inside values,
# and passwords may contain characters like $ and &.
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
PORT="$(env_value PORT)"
WORLD_DIR="$(env_value WORLD_DIR)"
APP="http://127.0.0.1:${PORT:-4000}"

managed=false
if command -v systemctl >/dev/null && systemctl list-unit-files "${SERVICE}.service" >/dev/null 2>&1 \
  && systemctl list-unit-files "${SERVICE}.service" | grep -q "^${SERVICE}.service"; then
  managed=true
fi

if $managed; then systemctl stop "$SERVICE"; fi
rm -rf "${WORLD_DIR:-data}"
docker exec bs_courier rm -f /data/owners.json
npm run -s seed

if $managed; then
  systemctl start "$SERVICE"
else
  echo "Start the app now (npm start). Waiting for it on $APP"
fi
for _ in $(seq 1 60); do curl -fs -o /dev/null "$APP/api/transfers" && break; sleep 2; done
curl -fs -o /dev/null "$APP/api/transfers" || { echo "The app didn't come up on $APP" >&2; exit 1; }

# STARTER=off leaves a fresh network with no transfers, for recording the whole flow from the start
if [ "${STARTER:-on}" = off ]; then echo "Fresh network ready, no starter round."; exit 0; fi
npx tsx scripts/demo-starter.ts "$APP"
