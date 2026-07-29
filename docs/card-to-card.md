# Card-to-card payment workflow

Hollowcon intentionally supports no payment method other than manually reviewed Iranian card-to-card transfer.

1. The server chooses an active recipient card and reserves an unused unique suffix from 1–999 rials.
2. The customer sees the exact rial amount and optional toman equivalent. The reservation expires after the configured window.
3. The customer uploads one JPEG, PNG, WebP, or PDF receipt. The file is private and treated as untrusted; storage and content inspection will be performed before the commerce service receives its metadata.
4. The order enters `under_review`. Finance/admin staff compare the receipt with the exact amount and recipient card.
5. Approval runs in one database transaction with row locking: create the review, approve the order, append the financial/audit event, and create one provisioning outbox event.
6. Repeated approval attempts are rejected by unique database constraints and state checks.
7. Image hashes only flag possible duplicate submissions; they never approve payments automatically.

Receipt-only review cannot prove settlement by itself. Operators must verify the transfer against their bank records before approval.
