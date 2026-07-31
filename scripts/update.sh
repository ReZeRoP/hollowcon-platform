#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] || { echo "Refusing update: working tree is not clean." >&2; exit 1; }
"$ROOT_DIR/scripts/backup.sh"
git -C "$ROOT_DIR" fetch --tags origin
TARGET="${1:-}"
[[ -n "$TARGET" ]] || { echo "Usage: scripts/update.sh <immutable-release-tag>" >&2; exit 2; }
[[ "$TARGET" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Refusing update: target must be an immutable release tag such as v0.2.0." >&2; exit 2; }
git -C "$ROOT_DIR" rev-parse -q --verify "refs/tags/$TARGET^{commit}" >/dev/null || { echo "Release tag $TARGET was not found." >&2; exit 2; }
git -C "$ROOT_DIR" checkout --detach "$TARGET"
"$ROOT_DIR/scripts/install.sh"
echo "Updated to $(git -C "$ROOT_DIR" rev-parse --short HEAD). Database migrations are forward-only; use restore for schema rollback."
