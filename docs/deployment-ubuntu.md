# Deploy Hollowcon from GitHub on Ubuntu

> Hollowcon now includes the first complete purchase-flow implementation: Telegram-authenticated setup, plans, manual card-to-card orders, receipt storage, finance review, an idempotent provisioning worker, Mini App screens, and an admin surface. It remains **pre-production** until you complete the controlled live-panel smoke test below. Do not enable real customer orders or panel mutations before that gate succeeds.

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

4. Confirm the payment-review screen, private receipt storage, and a full backup/restore drill.
5. Choose one controlled inbound and a low-value test order. Set both flags to `true`, deploy with `./scripts/update.sh`, approve the test receipt only after manual bank confirmation, and verify the deterministic client, delivered links, audit event, and status screens.
6. Keep a tested backup. Only then enable real customer orders. If an external panel call is ambiguous, leave the job in manual review; do not delete or recreate clients blindly.

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
- Verify transfers against bank records; receipt images never prove settlement automatically.
