# Security model

- Verify Telegram webhooks with a random secret header.
- Verify Mini App `initData`, enforce freshness, and derive identity only on the server.
- Use a dedicated full-admin 3x-ui API token per panel, HTTPS, encrypted-at-rest credentials, timeouts, and redacted logs.
- Treat receipt files as hostile: private storage, magic-byte and MIME checks, strict size/dimension limits, random names, no public execution path, and short-lived authorized reads.
- Approvals require RBAC, confirmation, reason, row locking, immutable audit events, and idempotent outbox creation.
- PostgreSQL and Redis are internal-only. Production services run non-root with least privilege.
- No secrets, full subscription URLs, panel tokens, receipt images, or customer identifiers in logs.

## Threats explicitly tested before release

Forged Telegram requests, stale init data, forged or reused receipts, duplicate approvals, duplicate provisioning, trial/referral abuse, unauthorized admin actions, SSRF through panel URLs, malicious uploads, queue replay, credential leakage, database loss, and compromised backups.
