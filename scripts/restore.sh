#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="${1:-}"
[[ -d "$BACKUP" && -f "$BACKUP/database.dump" && -f "$BACKUP/SHA256SUMS" ]] || { echo "Usage: scripts/restore.sh <backup-directory>" >&2; exit 2; }
echo "DANGER: restore replaces the Hollowcon database and receipts. Type RESTORE-HOLLOWCON to continue:"
read -r CONFIRM
[[ "$CONFIRM" == "RESTORE-HOLLOWCON" ]] || { echo "Cancelled."; exit 1; }
(cd "$BACKUP" && sha256sum -c SHA256SUMS)
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml")
"${COMPOSE[@]}" stop api bot worker web
"${COMPOSE[@]}" exec -T postgres dropdb -U hollowcon --if-exists hollowcon
"${COMPOSE[@]}" exec -T postgres createdb -U hollowcon hollowcon
"${COMPOSE[@]}" exec -T postgres pg_restore -U hollowcon -d hollowcon --clean --if-exists < "$BACKUP/database.dump"
"${COMPOSE[@]}" run --rm --no-deps -T --user 0:0 api sh -c 'rm -rf /var/lib/hollowcon/receipts/* && tar -C /var/lib/hollowcon -xzf -' < "$BACKUP/receipts.tar.gz"
"${COMPOSE[@]}" up -d
"$ROOT_DIR/scripts/doctor.sh"
