#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose.prod.yml"

if [[ ! -f /etc/os-release ]]; then echo "Unsupported system: /etc/os-release is missing" >&2; exit 1; fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
  echo "Supported systems: Ubuntu 22.04 and 24.04" >&2; exit 1
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "Install Docker Engine and the Compose plugin from https://docs.docker.com/engine/install/ubuntu/ then rerun." >&2
  exit 1
fi
if [[ ! -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  chmod 600 "$ROOT_DIR/.env"
  echo "Created $ROOT_DIR/.env. Replace every placeholder, then rerun this command." >&2
  exit 2
fi
if grep -Eq 'replace-|example\.com|INITIAL_OWNER_TELEGRAM_ID=0' "$ROOT_DIR/.env"; then
  echo "Refusing deployment: .env still contains placeholders." >&2; exit 2
fi

docker compose --env-file "$ROOT_DIR/.env" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$ROOT_DIR/.env" -f "$COMPOSE_FILE" build
docker compose --env-file "$ROOT_DIR/.env" -f "$COMPOSE_FILE" up -d --force-recreate
"$ROOT_DIR/scripts/doctor.sh"

echo "Hollowcon pre-release foundation is running. Complete product features remain under development."
