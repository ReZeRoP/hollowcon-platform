-- Production completion: truthful delivery states, safe amount reservations,
-- receipt evidence revisions, operator lifecycle metadata, and resumable notifications.

CREATE TYPE "CustomerOrderMode" AS ENUM ('disabled', 'owner_test', 'enabled');

ALTER TABLE "SystemSettings"
  ADD COLUMN "customerOrderMode" "CustomerOrderMode" NOT NULL DEFAULT 'disabled';

-- Preserve an explicitly enabled legacy setting while making disabled the safe default.
UPDATE "SystemSettings"
SET "customerOrderMode" = CASE WHEN "customerOrdersEnabled" THEN 'enabled'::"CustomerOrderMode" ELSE 'disabled'::"CustomerOrderMode" END;

ALTER TABLE "User"
  ADD COLUMN "roleAssignedAt" TIMESTAMP(3),
  ADD COLUMN "roleRevokedAt" TIMESTAMP(3),
  ADD COLUMN "disabledAt" TIMESTAMP(3);
UPDATE "User" SET "roleAssignedAt" = "createdAt" WHERE "role" IS NOT NULL AND "roleAssignedAt" IS NULL;

ALTER TABLE "Subscription" ADD COLUMN "provisionedAt" TIMESTAMP(3);
-- Earlier releases used deliveredAt for successful remote provisioning. Preserve the
-- timestamp as provisionedAt and clear deliveredAt because no notification consumer existed.
UPDATE "Subscription"
SET "provisionedAt" = COALESCE("deliveredAt", "createdAt"), "deliveredAt" = NULL
WHERE "linksEncrypted" IS NOT NULL;
UPDATE "ProvisioningJob" SET "status" = 'provisioned' WHERE "status" = 'delivered';

ALTER TABLE "Notification"
  ADD COLUMN "deliveryStep" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "messageIds" JSONB;

-- Retain every submitted receipt as auditable evidence instead of overwriting its file.
DROP INDEX IF EXISTS "PaymentReceipt_orderId_key";
ALTER TABLE "PaymentReceipt"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "current" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "replacedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "PaymentReceipt_orderId_revision_key" ON "PaymentReceipt"("orderId", "revision");
CREATE INDEX "PaymentReceipt_orderId_current_idx" ON "PaymentReceipt"("orderId", "current");
CREATE UNIQUE INDEX "PaymentReceipt_one_current_per_order_key" ON "PaymentReceipt"("orderId") WHERE "current" = true;

-- The previous index included the exact expiry timestamp, so concurrent transactions could
-- reserve the same suffix with slightly different expiry timestamps. Only live reservation-
-- holding states participate in this database-enforced uniqueness rule. Stale reservations
-- are expired transactionally before new allocation.
DROP INDEX IF EXISTS "Order_recipientCardId_payableAmountRial_reservationExpires_key";
CREATE UNIQUE INDEX "Order_active_card_suffix_key"
  ON "Order"("recipientCardId", "uniqueSuffixRial")
  WHERE "status" IN ('draft', 'awaiting_receipt', 'under_review', 'rejected');
