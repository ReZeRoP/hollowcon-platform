import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { loadConfig } from "@hollowcon/config";
import { decryptSecret, encryptSecret } from "@hollowcon/security";
import { ThreeXUiClient, ThreeXUiError } from "@hollowcon/three-x-ui";

const config = loadConfig();
const port = Number.parseInt(process.env["WORKER_HEALTH_PORT"] ?? "3003", 10);
const prisma = new PrismaClient();
const workerId = `worker:${randomUUID()}`;
let databaseReady = false;
let processorReady = false;
let processing = false;

const ORDER_PROVISIONING_REQUESTED = "order.provisioning.requested";

async function checkDatabase(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseReady = true;
  } catch {
    databaseReady = false;
  }
}

async function poll(): Promise<void> {
  if (processing || !databaseReady) return;
  processing = true;
  try {
    await recoverExpiredLeases();
    const event = await claimEvent();
    if (event) await processEvent(event.id, event.eventType, event.payload);
    processorReady = true;
  } catch (error) {
    processorReady = false;
    console.error(JSON.stringify({ level: "error", service: "worker", event: "poll.failed", error: safeError(error) }));
  } finally {
    processing = false;
  }
}

async function claimEvent(): Promise<{ id: string; eventType: string; payload: unknown } | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + config.WORKER_LEASE_SECONDS * 1_000);
  return prisma.$transaction(async (transaction) => {
    const candidate = await transaction.outboxEvent.findFirst({
      where: {
        processedAt: null,
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;
    const claimed = await transaction.outboxEvent.updateMany({
      where: {
        id: candidate.id,
        processedAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseOwner: workerId, leaseExpiresAt, attempts: { increment: 1 } },
    });
    return claimed.count === 1 ? candidate : null;
  });
}

async function processEvent(eventId: string, eventType: string, payload: unknown): Promise<void> {
  if (eventType !== ORDER_PROVISIONING_REQUESTED) {
    await markEventProcessed(eventId);
    return;
  }
  const parsed = parseProvisioningPayload(payload);
  if (!parsed) {
    await failEvent(eventId, "invalid_event_payload", false);
    return;
  }
  try {
    await provisionOrder(parsed.orderId, parsed.provisioningJobId);
    await markEventProcessed(eventId);
  } catch (error) {
    const retryable = isRetryable(error);
    await failEvent(eventId, safeError(error), retryable);
  }
}

async function provisionOrder(orderId: string, jobId: string): Promise<void> {
  const job = await prisma.provisioningJob.findUnique({
    where: { id: jobId },
    include: {
      order: {
        include: {
          user: true,
          plan: { include: { eligibleInbounds: { include: { panelInbound: { include: { panel: true } } } } } },
          subscription: true,
        },
      },
    },
  });
  if (!job || job.orderId !== orderId) throw new Error("Provisioning job not found");
  if (job.status === "delivered") return;
  if (!config.PANEL_MUTATIONS_ENABLED) throw new ManualReviewError("Panel mutations are disabled by deployment policy");

  const leaseExpiresAt = new Date(Date.now() + config.WORKER_LEASE_SECONDS * 1_000);
  const claimed = await prisma.provisioningJob.updateMany({
    where: {
      id: job.id,
      status: { in: ["queued", "failed", "manual_review"] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
    },
    data: { status: "running", leaseOwner: workerId, leaseExpiresAt, lockedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  const candidate = selectInbound(job.order.plan.eligibleInbounds.map((eligible) => eligible.panelInbound));
  if (!candidate) throw new ManualReviewError("No healthy plan-eligible inbound is available");
  const panel = candidate.panel;
  const token = decryptSecret({
    ciphertext: panel.apiTokenEncrypted,
    masterKey: config.PANEL_CREDENTIAL_MASTER_KEY,
    purpose: "panel-token",
    context: panel.baseUrl,
    expectedKeyId: panel.apiTokenKeyId,
  });
  const client = new ThreeXUiClient({ baseUrl: panel.baseUrl, apiToken: token });
  const remoteClientEmail = deterministicClientEmail(orderId);
  const existing = await getExistingClient(client, remoteClientEmail);
  const expiresAt = new Date(Date.now() + job.order.durationDays * 86_400_000);
  if (!existing) {
    await client.createClient({
      email: remoteClientEmail,
      inboundIds: [candidate.remoteId],
      expiryTime: expiresAt.getTime(),
      totalGB: Number(job.order.trafficBytes),
      limitIp: job.order.deviceLimit,
      telegramId: Number(job.order.user.telegramId),
      comment: `hollowcon:${orderId}`,
    });
  }
  const verified = await client.getClient(remoteClientEmail);
  const links = await client.clientLinks(remoteClientEmail);
  const encryptedLinks = encryptSecret({
    plaintext: JSON.stringify(links),
    masterKey: config.PANEL_CREDENTIAL_MASTER_KEY,
    purpose: "subscription-links",
    context: orderId,
  });

  await prisma.$transaction(async (transaction) => {
    await transaction.subscription.upsert({
      where: { orderId },
      create: {
        userId: job.order.userId,
        orderId,
        panelId: panel.id,
        panelInboundId: candidate.id,
        remoteClientEmail,
        remoteSubId: verified.subId,
        status: "active",
        trafficBytes: job.order.trafficBytes,
        expiresAt,
        linksEncrypted: encryptedLinks.ciphertext,
        linksKeyId: encryptedLinks.keyId,
        deliveredAt: new Date(),
      },
      update: {
        remoteSubId: verified.subId,
        status: "active",
        trafficBytes: job.order.trafficBytes,
        expiresAt,
        linksEncrypted: encryptedLinks.ciphertext,
        linksKeyId: encryptedLinks.keyId,
        deliveredAt: new Date(),
      },
    });
    await transaction.provisioningJob.update({
      where: { id: job.id },
      data: { status: "delivered", deliveredAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorSafe: null },
    });
    await transaction.notification.upsert({
      where: { idempotencyKey: `subscription-delivered:${orderId}` },
      create: {
        userId: job.order.userId,
        channel: "telegram",
        template: "subscription.delivered",
        payload: { orderId, subscriptionEmail: remoteClientEmail },
        idempotencyKey: `subscription-delivered:${orderId}`,
      },
      update: {},
    });
    await transaction.auditEvent.create({
      data: {
        action: "subscription.provisioned",
        subjectType: "order",
        subjectId: orderId,
        correlationId: workerId,
        metadata: { panelId: panel.id, panelInboundId: candidate.id, remoteClientEmail },
      },
    });
  });
}

async function getExistingClient(client: ThreeXUiClient, email: string): Promise<unknown> {
  try {
    return await client.getClient(email);
  } catch (error: unknown) {
    if (error instanceof ThreeXUiError && error.status === 404) return null;
    throw error;
  }
}

function selectInbound<T extends { enabled: boolean; panel: { enabled: boolean; circuitOpenUntil: Date | null; lastHealthyAt: Date | null }; activeClients: number; capacity: number | null }>(inbounds: readonly T[]): T | undefined {
  const now = new Date();
  return inbounds
    .filter((inbound) => inbound.enabled && inbound.panel.enabled && (!inbound.panel.circuitOpenUntil || inbound.panel.circuitOpenUntil <= now))
    .filter((inbound) => inbound.capacity === null || inbound.activeClients < inbound.capacity)
    .sort((left, right) => (left.activeClients / (left.capacity ?? Number.MAX_SAFE_INTEGER)) - (right.activeClients / (right.capacity ?? Number.MAX_SAFE_INTEGER)))[0];
}

function deterministicClientEmail(orderId: string): string {
  return `hc-${orderId}@hollowcon.invalid`;
}

async function markEventProcessed(eventId: string): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { id: eventId, leaseOwner: workerId },
    data: { processedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastErrorSafe: null },
  });
}

async function failEvent(eventId: string, error: string, retryable: boolean): Promise<void> {
  const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } });
  if (!event || event.leaseOwner !== workerId) return;
  const exhausted = !retryable || event.attempts >= config.WORKER_MAX_ATTEMPTS;
  const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(event.attempts, 10));
  await prisma.outboxEvent.update({
    where: { id: event.id },
    data: exhausted
      ? { processedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastErrorSafe: error }
      : { availableAt: new Date(Date.now() + delay), leaseOwner: null, leaseExpiresAt: null, lastErrorSafe: error },
  });
  if (exhausted) {
    await prisma.provisioningJob.updateMany({
      where: { idempotencyKey: `provision-order:${parseOrderId(event.payload) ?? "missing"}` },
      data: { status: "manual_review", leaseOwner: null, leaseExpiresAt: null, lastErrorSafe: error },
    });
  }
}

async function recoverExpiredLeases(): Promise<void> {
  const now = new Date();
  await Promise.all([
    prisma.outboxEvent.updateMany({ where: { processedAt: null, leaseExpiresAt: { lt: now } }, data: { leaseOwner: null, leaseExpiresAt: null } }),
    prisma.provisioningJob.updateMany({ where: { status: "running", leaseExpiresAt: { lt: now } }, data: { status: "failed", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now } }),
  ]);
}

function parseProvisioningPayload(value: unknown): { orderId: string; provisioningJobId: string } | null {
  if (!isRecord(value)) return null;
  const orderId = value["orderId"];
  const provisioningJobId = value["provisioningJobId"];
  return typeof orderId === "string" && typeof provisioningJobId === "string" ? { orderId, provisioningJobId } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOrderId(value: unknown): string | null {
  return parseProvisioningPayload(value)?.orderId ?? null;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ManualReviewError) return false;
  if (error instanceof ThreeXUiError) return error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
  return true;
}

function safeError(error: unknown): string {
  if (error instanceof ManualReviewError) return error.message;
  if (error instanceof ThreeXUiError) return `3x-ui:${error.status ?? "network"}`;
  return "worker_operation_failed";
}

class ManualReviewError extends Error {}

const databaseInterval = setInterval(() => void checkDatabase(), 10_000);
const workInterval = setInterval(() => void poll(), config.WORKER_POLL_INTERVAL_MS);
void checkDatabase().then(poll);

const server = createServer((_request, response) => {
  const status = databaseReady && processorReady ? 200 : 503;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: status === 200 ? "ready" : "starting", service: "worker", processorReady }));
});

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "worker", event: "listening", port, workerId }));
});

async function shutdown(): Promise<void> {
  clearInterval(databaseInterval);
  clearInterval(workInterval);
  server.close();
  await prisma.$disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
