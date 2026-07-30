-- Complete purchase-flow foundation. This migration is intentionally forward-only.

CREATE TYPE "ReceiptProcessingStatus" AS ENUM ('pending', 'validated', 'rejected');
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sending', 'delivered', 'failed', 'manual_review');

CREATE TABLE "SystemSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "setupCompletedAt" TIMESTAMP(3),
    "termsVersion" TEXT NOT NULL DEFAULT '1',
    "defaultLocale" "Locale" NOT NULL DEFAULT 'fa',
    "supportContact" TEXT,
    "customerOrdersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "panelMutationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SystemSettings_singleton" CHECK ("id" = 1)
);

CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RecipientCard" ADD COLUMN "panKeyId" TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE "Panel" ADD COLUMN "apiTokenKeyId" TEXT NOT NULL DEFAULT 'primary';

ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN "planNameFa" TEXT;
ALTER TABLE "Order" ADD COLUMN "planNameEn" TEXT;
ALTER TABLE "Order" ADD COLUMN "durationDays" INTEGER;
ALTER TABLE "Order" ADD COLUMN "trafficBytes" BIGINT;
ALTER TABLE "Order" ADD COLUMN "deviceLimit" INTEGER;
ALTER TABLE "Order" ADD COLUMN "protocol" TEXT;

-- No existing checkout orders should be present in the pre-release deployment. The UPDATE
-- nevertheless makes the upgrade defensive for a manually seeded instance.
UPDATE "Order" AS o
SET
  "idempotencyKey" = 'legacy:' || o."id",
  "planNameFa" = p."nameFa",
  "planNameEn" = p."nameEn",
  "durationDays" = p."durationDays",
  "trafficBytes" = p."trafficBytes",
  "deviceLimit" = p."deviceLimit",
  "protocol" = p."protocol"
FROM "Plan" AS p
WHERE o."planId" = p."id";

ALTER TABLE "Order" ALTER COLUMN "idempotencyKey" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "planNameFa" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "planNameEn" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "durationDays" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "trafficBytes" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "deviceLimit" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "protocol" SET NOT NULL;

ALTER TABLE "PaymentReceipt" ADD COLUMN "detectedMediaType" TEXT;
ALTER TABLE "PaymentReceipt" ADD COLUMN "originalFileName" TEXT;
ALTER TABLE "PaymentReceipt" ADD COLUMN "telegramFileId" TEXT;
ALTER TABLE "PaymentReceipt" ADD COLUMN "duplicateCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaymentReceipt" ADD COLUMN "processingStatus" "ReceiptProcessingStatus" NOT NULL DEFAULT 'validated';
UPDATE "PaymentReceipt" SET "detectedMediaType" = "mediaType" WHERE "detectedMediaType" IS NULL;
ALTER TABLE "PaymentReceipt" ALTER COLUMN "detectedMediaType" SET NOT NULL;

CREATE TABLE "PlanInbound" (
    "planId" TEXT NOT NULL,
    "panelInboundId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanInbound_pkey" PRIMARY KEY ("planId", "panelInboundId")
);

ALTER TABLE "ProvisioningJob" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ProvisioningJob" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "ProvisioningJob" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "Subscription" ADD COLUMN "linksEncrypted" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "linksKeyId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trafficUsedBytes" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "OutboxEvent" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "lastErrorSafe" TEXT;

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_userId_expiresAt_idx" ON "AdminSession"("userId", "expiresAt");
CREATE INDEX "AdminSession_expiresAt_revokedAt_idx" ON "AdminSession"("expiresAt", "revokedAt");
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
CREATE INDEX "PlanInbound_panelInboundId_idx" ON "PlanInbound"("panelInboundId");
CREATE INDEX "ProvisioningJob_status_nextAttemptAt_idx" ON "ProvisioningJob"("status", "nextAttemptAt");
CREATE INDEX "ProvisioningJob_leaseExpiresAt_idx" ON "ProvisioningJob"("leaseExpiresAt");
CREATE INDEX "OutboxEvent_leaseExpiresAt_idx" ON "OutboxEvent"("leaseExpiresAt");
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");
CREATE INDEX "Notification_status_availableAt_idx" ON "Notification"("status", "availableAt");
CREATE INDEX "Notification_leaseExpiresAt_idx" ON "Notification"("leaseExpiresAt");

ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanInbound" ADD CONSTRAINT "PlanInbound_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanInbound" ADD CONSTRAINT "PlanInbound_panelInboundId_fkey" FOREIGN KEY ("panelInboundId") REFERENCES "PanelInbound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
