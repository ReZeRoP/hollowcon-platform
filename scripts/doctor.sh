#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/infra/compose.prod.yml")
[[ -f "$ROOT_DIR/.env" ]] || { echo ".env is missing" >&2; exit 1; }
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" ps
if "${COMPOSE[@]}" ps --status exited --services | grep -Ev '^(migrate|receipt-init)$' | grep -q .; then
  echo "One or more application services have exited." >&2; exit 1
fi
for service in postgres redis api web bot worker; do
  container_id="$("${COMPOSE[@]}" ps -q "$service")"
  [[ -n "$container_id" ]] || { echo "$service is not running." >&2; exit 1; }
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  [[ "$health" == "healthy" ]] || { echo "$service is not healthy: $health" >&2; exit 1; }
done
for service in migrate receipt-init; do
  container_id="$("${COMPOSE[@]}" ps -aq "$service")"
  [[ -n "$container_id" ]] || { echo "$service did not run." >&2; exit 1; }
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")"
  [[ "$exit_code" == "0" ]] || { echo "$service failed with exit code $exit_code." >&2; exit 1; }
done
"${COMPOSE[@]}" exec -T api sh -c 'test -d /var/lib/hollowcon/receipts && test -r /var/lib/hollowcon/receipts && test -w /var/lib/hollowcon/receipts'
"${COMPOSE[@]}" exec -T bot sh -c 'test -d /var/lib/hollowcon/receipts && test -r /var/lib/hollowcon/receipts && test -w /var/lib/hollowcon/receipts'
"${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:3000/health/ready | grep -q '"status":"ready"'
"${COMPOSE[@]}" exec -T web wget -qO- http://127.0.0.1:3001/health/ready | grep -q '"status":"ready"'
"${COMPOSE[@]}" exec -T bot wget -qO- http://127.0.0.1:3002 | grep -q '"status":"ready"'
"${COMPOSE[@]}" exec -T worker wget -qO- http://127.0.0.1:3003 | grep -q '"status":"ready"'
base_url="$(awk -F= '$1 == "PUBLIC_BASE_URL" { print substr($0, index($0, "=") + 1) }' "$ROOT_DIR/.env" | tail -n 1)"
[[ "$base_url" == https://* ]] || { echo "PUBLIC_BASE_URL must use HTTPS." >&2; exit 1; }
curl --fail --silent --show-error --max-time 15 "$base_url/api/health/ready" | grep -q '"status":"ready"'
curl --fail --silent --show-error --max-time 15 "$base_url/" | grep -qi '<!doctype html>'
echo "Compose services, one-shot jobs, API routing, web delivery, and private receipt access are healthy."
