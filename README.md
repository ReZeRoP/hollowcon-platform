# Hollowcon

Hollowcon is a Persian-first Telegram bot, Mini App, and administration platform for selling subscription services provisioned through existing 3x-ui v3.5.0 panels.

## Product boundaries

- The only payment method is manually reviewed Iranian card-to-card transfer.
- Hollowcon connects to existing HTTPS 3x-ui panels; it does not install or modify 3x-ui databases.
- Persian RTL and English LTR are first-class interfaces.
- All monetary values are stored as integer Iranian rials.
- A small unique rial suffix helps administrators match receipts to pending orders; it never replaces manual review.

## Current status

Hollowcon is deployment-ready for a guarded production rollout. The repository includes Telegram-authenticated owner bootstrap, encrypted recipient-card and panel credentials, exact-rial card-to-card orders, private receipt evidence, manual finance review, idempotent 3x-ui provisioning, durable Telegram link/QR delivery, a Persian-first Mini App, RBAC administration, audit events, backup/restore tooling, and automated PostgreSQL and production-Compose validation.

A new installation intentionally starts with `CUSTOMER_ORDERS_ENABLED=false` and `PANEL_MUTATIONS_ENABLED=false`. Deploy the immutable release, complete owner setup, and run the documented low-value owner-only live-panel test before enabling normal customer orders. Receipt files never approve payments automatically; finance staff must match the exact rial amount against bank records.

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
