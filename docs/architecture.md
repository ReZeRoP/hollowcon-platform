# Architecture

```mermaid
flowchart LR
  T[Telegram users] --> B[Bot webhook]
  T --> M[Mini App]
  A[Administrators] --> W[Admin web]
  B --> API[Hollowcon API]
  M --> API
  W --> API
  API --> P[(PostgreSQL)]
  API --> R[(Redis queues)]
  R --> Q[Workers]
  Q --> X1[3x-ui v3.5.0 panel]
  Q --> X2[3x-ui v3.5.0 panel]
  Q --> N[Telegram notifications]
```

PostgreSQL is authoritative for commerce state. An order approval transaction records the review and emits an outbox event. Durable workers provision deterministic clients through one chosen panel, verify the result, and then mark delivery complete. Retries reuse the same idempotency identity.

External systems are adapters. The domain package does not depend on Telegram, 3x-ui, PostgreSQL, Redis, or UI frameworks.
