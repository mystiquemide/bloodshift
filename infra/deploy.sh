#!/usr/bin/env bash
# Deploys Bloodshift and a self-hosted Zetaris on one Ubuntu 24.04 server.
#
#   sudo ZETARIS_ZIP=/root/zetaris-platform.zip MODE=standalone bash infra/deploy.sh
#
# MODE=standalone  The server's ports 80 and 443 are free. Caddy serves Bloodshift over HTTPS
#                  at https://bloodshift.<ip-with-dashes>.sslip.io
# MODE=proxy       Another reverse proxy (Coolify, Traefik, nginx) already holds 80 and 443.
#                  Bloodshift listens on HOST:PORT and you point your proxy at it.
#
# Secrets are asked for interactively and written only to files readable by root.
# Zetaris stays on 127.0.0.1. Only Bloodshift is reachable from outside.
set -euo pipefail

MODE="${MODE:-standalone}"
ZETARIS_ZIP="${ZETARIS_ZIP:-}"
REPO_URL="${REPO_URL:-https://github.com/mystiquemide/bloodshift.git}"
APP_DIR="${APP_DIR:-/opt/bloodshift}"
ZETARIS_DIR="${ZETARIS_DIR:-/opt/zetaris-platform}"
ZETARIS_UI_PORT="${ZETARIS_UI_PORT:-3100}"
APP_PORT="${APP_PORT:-4000}"
REGISTRY="zetarishackathon.azurecr.io"

step() { printf '\n==> %s\n' "$*"; }
# Sets KEY=VALUE in an env file. The value passes through the environment, so characters
# like & $ | in passwords are written literally.
set_kv() {
  K="$2" V="$3" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$1" > "$1.tmp" && cat "$1.tmp" > "$1" && rm -f "$1.tmp"
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root (sudo)."
[ "$MODE" = standalone ] || [ "$MODE" = proxy ] || fail "MODE must be standalone or proxy."
[ -n "$ZETARIS_ZIP" ] && [ -f "$ZETARIS_ZIP" ] || fail "Set ZETARIS_ZIP to the zetaris-platform.zip you downloaded from Zetaris Cloud (Run locally)."

step "Checking the machine"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "Warning: tested on Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}."
[ "$(uname -m)" = x86_64 ] || fail "Zetaris images are x86_64 only."
mem_gb=$(awk '/MemAvailable/ {printf "%d", $2/1024/1024}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "Available memory: ${mem_gb} GB. Free disk: ${disk_gb} GB."
[ "$disk_gb" -ge 15 ] || fail "Need at least 15 GB free disk for the images."
if [ "$mem_gb" -lt 5 ]; then
  echo "Warning: Zetaris and Bloodshift need about 4 GB. With ${mem_gb} GB available the query engine may run out of memory."
  read -r -p "Continue anyway? [y/N] " ok; [ "$ok" = y ] || exit 1
fi
if [ "$MODE" = standalone ] && ss -tln | grep -qE ':(80|443)\s'; then
  fail "Ports 80 or 443 are already in use. Use MODE=proxy and route your existing proxy to Bloodshift."
fi

step "Installing Docker, Node 22 and tools if missing"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip git ca-certificates openssl >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
docker compose version >/dev/null || fail "Docker Compose plugin is missing."
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Docker $(docker --version | awk '{print $3}' | tr -d ,), Node $(node --version)"

step "Collecting secrets (input is hidden)"
while :; do
  read -r -s -p "Choose a Zetaris admin password (8+ chars, upper, lower, digit, one of \$@!%*?&): " ZPASS; echo
  [[ ${#ZPASS} -ge 8 && $ZPASS =~ [a-z] && $ZPASS =~ [A-Z] && $ZPASS =~ [0-9] && $ZPASS =~ [\$@!%*?\&] && ! $ZPASS =~ [^A-Za-z0-9\$@!%*?\&] ]] && break
  echo "That password doesn't meet Zetaris's rules. Try again."
done
read -r -s -p "NVIDIA API key for Nemotron (leave empty to use the standard template): " NVKEY; echo
if ! grep -q "$REGISTRY" /root/.docker/config.json 2>/dev/null; then
  echo "Sign in to the Zetaris image registry. Use the username and password from the docker login command on the Zetaris Cloud Run locally page."
  docker login "$REGISTRY"
fi

step "Setting up Zetaris in $ZETARIS_DIR"
mkdir -p "$(dirname "$ZETARIS_DIR")"
if [ ! -d "$ZETARIS_DIR" ]; then
  tmp=$(mktemp -d); unzip -q "$ZETARIS_ZIP" -d "$tmp"; mv "$tmp/zetaris-platform" "$ZETARIS_DIR"; rm -rf "$tmp"
  envf="$ZETARIS_DIR/.env"
  # The admin account is created once, on first start, from this value
  set_kv "$envf" ZETARIS_ADMIN_PASSWORD "$ZPASS"
  # The bundle publishes its UI on every interface, and Docker-published ports bypass UFW. Keep it on loopback.
  set_kv "$envf" UI_PORT "127.0.0.1:${ZETARIS_UI_PORT}"
  set_kv "$envf" ALLOWED_ORIGINS "http://localhost:${ZETARIS_UI_PORT}"
  set_kv "$envf" GUI_URL "http://localhost:${ZETARIS_UI_PORT}"
  chmod 600 "$envf"
else
  echo "Keeping the existing Zetaris install. Its admin password was set on first start."
fi
(cd "$ZETARIS_DIR" && ./preflight.sh) || fail "Zetaris preflight failed. Fix what it reports and run this script again."
(cd "$ZETARIS_DIR" && docker compose pull -q && docker compose up -d)

step "Waiting for the Zetaris query engine and API (5 to 10 minutes on first start)"
for i in $(seq 1 120); do
  d=$(docker inspect -f '{{.State.Health.Status}}' zetaris-driver-1 2>/dev/null || true)
  a=$(docker inspect -f '{{.State.Health.Status}}' zetaris-api-1 2>/dev/null || true)
  [ "$d" = healthy ] && [ "$a" = healthy ] && break
  sleep 10
done
[ "$d" = healthy ] && [ "$a" = healthy ] || fail "Zetaris didn't become healthy. Check: cd $ZETARIS_DIR && docker compose logs driver"
echo "Zetaris is healthy."

step "Getting Bloodshift into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull -q --ff-only; else git clone -q "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"
npm ci --silent

if [ ! -f .env ]; then
  cp .env.example .env
  set_env() { set_kv .env "$1" "$2"; }
  set_env ZETARIS_BASE_URL "http://127.0.0.1:${ZETARIS_UI_PORT}"
  set_env ZETARIS_USERNAME "admin@zetaris.com"
  set_env ZETARIS_PASSWORD "$ZPASS"
  set_env SITE_A_PASSWORD "$(openssl rand -hex 16)"
  set_env SITE_B_PASSWORD "$(openssl rand -hex 16)"
  set_env NVIDIA_API_KEY "$NVKEY"
  set_env PORT "$APP_PORT"
  set_env HOST "$([ "$MODE" = proxy ] && echo 0.0.0.0 || echo 127.0.0.1)"
  chmod 600 .env
else
  echo "Keeping the existing .env."
fi

step "Starting the hospital sources and the courier, seeding, registering in Zetaris"
npm run -s sources:up
npm run -s seed
npm run -s register

step "Running Bloodshift as a service"
cat > /etc/systemd/system/bloodshift.service <<UNIT
[Unit]
Description=Bloodshift
After=docker.service network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v npm) start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bloodshift >/dev/null
systemctl restart bloodshift
for i in $(seq 1 30); do curl -fs -o /dev/null "http://127.0.0.1:${APP_PORT}/" && break; sleep 1; done
curl -fs -o /dev/null "http://127.0.0.1:${APP_PORT}/" || fail "Bloodshift didn't start. Check: journalctl -u bloodshift -n 50"
curl -fs "http://127.0.0.1:${APP_PORT}/api/stock" | grep -q '"state":"loaded"' && echo "All four sources read live through Zetaris." || echo "Warning: not every source is live yet. Check the app's status bar."

step "Resetting the demo every 6 hours"
# Synthetic stock and courier slots are relative to the time of seeding, so the demo is reset
# at 00, 06, 12 and 18 UTC with fresh stock and one real starter round.
cat > /etc/systemd/system/bloodshift-reset.service <<UNIT
[Unit]
Description=Reset the Bloodshift demo network
After=bloodshift.service

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/scripts/reset-demo.sh
UNIT
cat > /etc/systemd/system/bloodshift-reset.timer <<UNIT
[Unit]
Description=Reset the Bloodshift demo network every 6 hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now bloodshift-reset.timer >/dev/null
systemctl start bloodshift-reset.service && echo "Demo reset and starter round done." || echo "Warning: the demo reset failed. Check: journalctl -u bloodshift-reset -n 50"

ip=$(curl -fs https://api.ipify.org || hostname -I | awk '{print $1}')
if [ "$MODE" = standalone ]; then
  step "Serving over HTTPS with Caddy"
  domain="bloodshift.${ip//./-}.sslip.io"
  mkdir -p /opt/bloodshift-caddy
  printf '%s {\n  reverse_proxy 127.0.0.1:%s\n}\n' "$domain" "$APP_PORT" > /opt/bloodshift-caddy/Caddyfile
  docker rm -f bloodshift-caddy >/dev/null 2>&1 || true
  docker run -d --name bloodshift-caddy --restart unless-stopped --network host \
    -v /opt/bloodshift-caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v bloodshift-caddy-data:/data caddy:2-alpine >/dev/null
  echo "Waiting for the certificate..."
  for i in $(seq 1 30); do curl -fs -o /dev/null "https://${domain}/" && break; sleep 3; done
  if curl -fs -o /dev/null "https://${domain}/"; then echo "Live at https://${domain}"; else echo "Caddy is running but https://${domain} isn't answering yet. If your provider has a cloud firewall, open 80 and 443 there."; fi
else
  step "Point your reverse proxy at Bloodshift"
  echo "Bloodshift listens on 0.0.0.0:${APP_PORT}. Keep that port closed to the public in your firewall."
  echo "If your proxy runs in Docker (Coolify, Traefik), let its network reach the port, for example:"
  echo "  ufw allow from 10.0.1.0/24 to any port ${APP_PORT} proto tcp"
  echo "Then route your domain to http://host.docker.internal:${APP_PORT} (or this server's Docker gateway IP)."
fi

step "Done"
echo "Zetaris: private on 127.0.0.1:${ZETARIS_UI_PORT}. Secrets: $APP_DIR/.env and $ZETARIS_DIR/.env (root only)."
echo "Logs: journalctl -u bloodshift -f"
