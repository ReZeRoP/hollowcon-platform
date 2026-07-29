#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml")
if [[ "${1:-}" == "--delete-data" ]]; then
  echo "DANGER: this permanently deletes Hollowcon database, receipts, Redis, and TLS volumes. Type DELETE-HOLLOWCON-DATA:"
  read -r CONFIRM
  [[ "$CONFIRM" == "DELETE-HOLLOWCON-DATA" ]] || { echo "Data deletion cancelled."; exit 1; }
  "$ROOT_DIR/scripts/backup.sh"
  "${COMPOSE[@]}" down --volumes
else
  "${COMPOSE[@]}" down
  echo "Containers and networks removed. Named volumes and all data were preserved."
fi
