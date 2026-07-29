#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
[[ -n "$TARGET" ]] || { echo "Usage: scripts/rollback.sh <git-tag-or-commit>" >&2; exit 2; }
echo "This rolls back application code only. It does not reverse database migrations."
git -C "$ROOT_DIR" fetch --tags origin
git -C "$ROOT_DIR" checkout --detach "$TARGET"
docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml build api web bot worker
docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml up -d --no-deps api web bot worker
"$ROOT_DIR/scripts/doctor.sh"
