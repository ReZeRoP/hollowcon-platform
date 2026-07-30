# Deploy Hollowcon from GitHub on Ubuntu

> Hollowcon is currently a deployable **pre-release foundation**. Containers, TLS, database migrations, health checks, the starter bot, and the holding web page run. The complete commerce API, provisioning worker, Mini App, and admin dashboard are not finished and must not yet be used for real customers or payments.

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

`backup.sh` creates a PostgreSQL custom dump, a receipt archive, and SHA-256 checksums. It lists expired backup directories but does not automatically delete them. Copy backups to encrypted off-server storage and regularly test restoration.

## Security notes

- Never commit `.env`, receipt files, backups, panel tokens, or Telegram tokens.
- PostgreSQL and Redis are not published on host ports in the production Compose stack.
- Receipt and payment features are not production-ready until secure upload/content inspection and real concurrency tests are complete.
- The starter bot currently uses Telegram long polling. Webhook mode will replace it when the full API is implemented.
- Verify transfers against bank records; receipt images never prove settlement automatically.
