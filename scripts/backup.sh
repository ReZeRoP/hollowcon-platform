#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"
chmod 700 "$BACKUP_ROOT" "$DEST"
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml")
"${COMPOSE[@]}" exec -T postgres pg_dump -U hollowcon -d hollowcon -Fc > "$DEST/database.dump"
"${COMPOSE[@]}" run --rm --no-deps -v "$DEST:/backup" api sh -c 'tar -C /var/lib/hollowcon -czf /backup/receipts.tar.gz receipts'
sha256sum "$DEST/database.dump" "$DEST/receipts.tar.gz" > "$DEST/SHA256SUMS"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${BACKUP_RETENTION_DAYS:-14}" -print
echo "Backup written to $DEST. Old backup paths were listed but not deleted."
