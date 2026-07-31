# Deploy Hollowcon from GitHub on Ubuntu

> Hollowcon is deployment-ready for a guarded production rollout: Telegram-authenticated setup, plans, manual card-to-card orders, private receipt storage, finance review, idempotent provisioning, durable Telegram delivery, Mini App screens, RBAC administration, and Ubuntu operations are included. New deployments intentionally keep customer orders and panel mutations disabled until the controlled live-panel acceptance test below succeeds.

## Requirements

- Ubuntu 22.04 or 24.04
- A domain whose `A`/`AAAA` record points to the server
- TCP ports 22, 80, and 443 open; UDP 443 is recommended
- Docker Engine and the Docker Compose plugin installed from Docker's official Ubuntu repository
- An existing HTTPS 3x-ui v3.5.0 panel for later integration

## Install

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
# Install Docker from: https://docs.docker.com/engine/install/ubuntu/
sudo install -d -m 0755 /opt/hollowcon
sudo chown "$USER":"$USER" /opt/hollowcon
git clone https://github.com/ReZeRoP/hollowcon-platform.git /opt/hollowcon
cd /opt/hollowcon
./scripts/install.sh
```

On the first run, `install.sh` creates `.env` with mode `0600` and stops. Edit every placeholder:

```bash
nano /opt/hollowcon/.env
```

Generate secrets locally on the server, for example:

```bash
openssl rand -base64 48
```

For `DATABASE_URL`, URL-encode special characters in `POSTGRES_PASSWORD`. Then rerun:

```bash
cd /opt/hollowcon
./scripts/install.sh
```

Caddy obtains and renews the TLS certificate automatically after DNS and firewall configuration are correct. Service ports are fixed inside the Compose network (`3000`–`3003`) and are not published publicly; do not add or override `API_PORT`, `WEB_PORT`, `BOT_HEALTH_PORT`, or `WORKER_HEALTH_PORT` in `.env`.

## First-run safety gate

1. Open the bot and then its Mini App (`https://your-domain/mini`) as the Telegram ID configured in `INITIAL_OWNER_TELEGRAM_ID`.
2. Complete the owner setup: recipient card, at least one plan, HTTPS 3x-ui URL/token, then select plan-eligible inbounds. The panel check performs read-only health and inbound discovery only.
3. Keep these values in `.env` while you verify setup:

```dotenv
CUSTOMER_ORDERS_ENABLED=false
PANEL_MUTATIONS_ENABLED=false
```

4. In BotFather, configure the Mini App URL and menu button to the exact HTTPS URL in `TELEGRAM_MINI_APP_URL`. Open the bot as the initial owner and confirm that the menu button launches inside Telegram, not a normal browser.
5. Confirm the payment-review screen, private receipt storage, and a full backup/restore drill. Run `./scripts/doctor.sh`; it now verifies service health, completed migration/receipt-init jobs, private volume permissions, internal readiness, public API routing, and web delivery.
6. Add operators from the Mini App owner screen. Assign only the required roles; changing or disabling an operator revokes active sessions. Finance staff must compare the exact rial amount to bank records manually before approval.
7. Choose one controlled inbound and a low-value owner-only test order. First set `PANEL_MUTATIONS_ENABLED=true` while keeping normal customer ordering disabled, then use database `owner_test` order mode for the owner account. Approve the test receipt only after manual bank confirmation.
8. Verify exactly one `hc-<order-id>@hollowcon.invalid` client exists on the selected 3x-ui inbound, with the correct traffic, device limit, and expiration. Confirm Telegram summary/link/QR delivery, Mini App configuration retrieval, provisioning and delivery timestamps, and audit records.
9. Replay or restart the worker once and confirm no duplicate remote client or duplicate completed delivery is created. If a panel response is ambiguous, keep the job in manual review; never delete or recreate clients blindly.
10. Keep a tested backup. Only after the controlled test succeeds should you set the database order mode to `enabled` and `CUSTOMER_ORDERS_ENABLED=true` for normal customers.

## Management and role boundaries

- **Owner:** bootstrap, safety settings, operators, cards, plans, panels, inbounds, finance, audit.
- **Admin:** operational management except owner-only account and global safety actions.
- **Finance:** manually inspect receipts and compare exact amounts against bank records; no automated settlement exists.
- **Server operator:** panel, inbound, provisioning, and system visibility without finance authority.
- **Support:** customer assistance without payment or infrastructure authority.
- **Marketing:** campaign/customer visibility only where explicitly exposed.
- **Auditor:** read-only operational and audit visibility.

Card, plan, panel, and inbound updates require authenticated same-origin requests, CSRF protection, role checks, explicit confirmation text, rate limiting, and audit events. Panel-token rotation is tested against the panel before encrypted storage. Never lower inbound capacity below current active usage or deactivate the last active recipient card.

## Operations

```bash
cd /opt/hollowcon
./scripts/status.sh
./scripts/doctor.sh
./scripts/logs.sh
./scripts/backup.sh
./scripts/update.sh                 # backup, fetch, deploy origin/main
./scripts/update.sh v0.2.0          # deploy an immutable tag
./scripts/rollback.sh <tag-or-sha>  # application code only
./scripts/restore.sh backups/<timestamp>
./scripts/uninstall.sh              # preserve data
./scripts/uninstall.sh --delete-data
```

`update.sh` always creates a backup before applying migrations. Prisma migrations are forward-only. `rollback.sh` never attempts to reverse database changes; use a verified backup and `restore.sh` when database rollback is required.

`backup.sh` creates a PostgreSQL custom dump, streams a receipt archive from the private Docker volume to a host-owned `0600` file, and writes SHA-256 checksums. Failed attempts remove incomplete backup artifacts. It lists expired backup directories but does not automatically delete them. Copy backups to encrypted off-server storage and regularly test restoration.

## Security notes

- Never commit `.env`, receipt files, backups, panel tokens, or Telegram tokens.
- PostgreSQL and Redis are not published on host ports in the production Compose stack.
- Receipt upload validates declared media type, content magic bytes, file size, SHA-256, and private randomized storage paths; staff access is authorized and audited.
- Receipt images are evidence for an operator, not automatic settlement proof. Do not enable automatic approval.
- The bot uses Telegram long polling for the first release. The web surface verifies Telegram Mini App data server-side and uses secure session cookies plus CSRF/origin checks.
- Redis-backed authentication and mutation rate limits fail closed. If Redis is unavailable, readiness fails and protected high-risk operations return a temporary service error rather than bypassing limits.
- Provisioned subscription links and panel tokens are encrypted at rest. Telegram delivery stores durable progress after every summary, link, and QR step so interruption resumes from the last confirmed step.
- Verify transfers against bank records; receipt images never prove settlement automatically.

## Release procedure

1. Review the complete diff and ensure `.env`, receipts, and backups are absent from Git.
2. Run `git diff --check` and `pnpm check` locally.
3. Commit and push to a branch, then wait for both GitHub Actions jobs:
   - Real PostgreSQL migration deployment, concurrency tests, schema drift, workspace checks, and shell validation.
   - Production image builds and an isolated Compose rehearsal for PostgreSQL, Redis, migrations, receipt initialization, API, web, worker, and shared receipt access.
4. Tag an immutable release only after CI passes.
5. On Ubuntu, run `./scripts/backup.sh`, then `./scripts/update.sh <release-tag>`.
6. Keep customer orders and panel mutations disabled until the controlled owner test described above succeeds.
