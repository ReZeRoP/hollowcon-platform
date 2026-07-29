#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml")
[[ -f "$ROOT_DIR/.env" ]] || { echo ".env is missing" >&2; exit 1; }
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" ps
if "${COMPOSE[@]}" ps --status exited --services | grep -Ev '^migrate$' | grep -q .; then
  echo "One or more application services have exited." >&2; exit 1
fi
echo "Compose configuration and service state look healthy."
