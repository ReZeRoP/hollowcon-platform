#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"
chmod 700 "$BACKUP_ROOT" "$DEST"
cleanup_failed_backup() {
  if [[ "${BACKUP_COMPLETE:-false}" != "true" ]]; then
    rm -f "$DEST/database.dump" "$DEST/receipts.tar.gz" "$DEST/SHA256SUMS"
    rmdir "$DEST" 2>/dev/null || true
  fi
}
trap cleanup_failed_backup EXIT
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml")
"${COMPOSE[@]}" exec -T postgres pg_dump -U hollowcon -d hollowcon -Fc > "$DEST/database.dump"
"${COMPOSE[@]}" run --rm --no-deps -T --user 0:0 api sh -c 'tar -C /var/lib/hollowcon -czf - receipts' > "$DEST/receipts.tar.gz"
chmod 600 "$DEST/database.dump" "$DEST/receipts.tar.gz"
sha256sum "$DEST/database.dump" "$DEST/receipts.tar.gz" > "$DEST/SHA256SUMS"
chmod 600 "$DEST/SHA256SUMS"
BACKUP_COMPLETE=true
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${BACKUP_RETENTION_DAYS:-14}" -print
echo "Backup written to $DEST. Old backup paths were listed but not deleted."
