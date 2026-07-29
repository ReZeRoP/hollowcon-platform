#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] || { echo "Refusing update: working tree is not clean." >&2; exit 1; }
"$ROOT_DIR/scripts/backup.sh"
git -C "$ROOT_DIR" fetch --tags origin
TARGET="${1:-origin/main}"
git -C "$ROOT_DIR" checkout --detach "$TARGET"
"$ROOT_DIR/scripts/install.sh"
echo "Updated to $(git -C "$ROOT_DIR" rev-parse --short HEAD). Database migrations are forward-only; use restore for schema rollback."
