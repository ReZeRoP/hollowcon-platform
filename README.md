# Hollowcon

Hollowcon is a Persian-first Telegram bot, Mini App, and administration platform for selling subscription services provisioned through existing 3x-ui v3.5.0 panels.

## Product boundaries

- The only payment method is manually reviewed Iranian card-to-card transfer.
- Hollowcon connects to existing HTTPS 3x-ui panels; it does not install or modify 3x-ui databases.
- Persian RTL and English LTR are first-class interfaces.
- All monetary values are stored as integer Iranian rials.
- A small unique rial suffix helps administrators match receipts to pending orders; it never replaces manual review.

## Current status

This repository is under active development and is **not yet a production release**. It now includes Telegram-authenticated owner bootstrap/setup, encrypted recipient-card and panel credentials, plans, exact-rial card-to-card orders, private receipt handling, manual finance review, idempotent 3x-ui provisioning, durable delivery notifications, a customer Mini App, and an owner/admin surface. The remaining release gates are PostgreSQL concurrency and end-to-end tests, a controlled non-destructive live-panel smoke test, verified backup/restore recovery, and an operator decision to enable the guarded `CUSTOMER_ORDERS_ENABLED` and `PANEL_MUTATIONS_ENABLED` flags. Do not accept real customer payments until those gates pass.

## Development

Requirements: Node.js 22+, Corepack/pnpm, and Docker Compose.

```bash
corepack enable
pnpm install --frozen-lockfile=false
docker compose -f infra/compose.dev.yml up -d
pnpm check
```

Copy `.env.example` to `.env` and replace every placeholder locally. Never commit `.env`.

## Documentation

- [3x-ui v3.5.0 compatibility](docs/3x-ui-3.5.0-compatibility.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Card-to-card workflow](docs/card-to-card.md)
- [Ubuntu deployment](docs/deployment-ubuntu.md)

## License

AGPL-3.0-only. See `LICENSE`.
