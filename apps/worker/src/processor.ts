import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "@hollowcon/config";
import { decryptSecret, encryptSecret } from "@hollowcon/security";
import {
  ThreeXUiClient,
  ThreeXUiError,
  type CreateClientInput,
} from "@hollowcon/three-x-ui";

import {
  deterministicClientEmail,
  isRetryable,
  ManualReviewError,
  parseOrderId,
  parseProvisioningPayload,
  safeExternalInteger,
  safeWorkerError,
  selectInbound,
} from "./logic.js";

const ORDER_PROVISIONING_REQUESTED = "order.provisioning.requested";

export type ProvisioningOutcome = "completed" | "deferred";

type WorkerConfig = Pick<
  AppConfig,
  | "PANEL_CREDENTIAL_MASTER_KEY"
  | "PANEL_MUTATIONS_ENABLED"
  | "WORKER_LEASE_SECONDS"
  | "WORKER_MAX_ATTEMPTS"
>;

export interface ProvisioningPanelClient {
  getClient(email: string): Promise<{ readonly subId?: string | null | undefined }>;
  createClient(input: CreateClientInput): Promise<unknown>;
  clientLinks(email: string): Promise<string[]>;
}

export type ProvisioningPanelClientFactory = (
  baseUrl: string,
  apiToken: string,
) => ProvisioningPanelClient;

export interface WorkerProcessorDependencies {
  readonly config: WorkerConfig;
  readonly prisma: PrismaClient;
  readonly workerId: string;
  readonly now?: () => Date;
  readonly createPanelClient?: ProvisioningPanelClientFactory;
}

export class WorkerProcessor {
  private readonly config: WorkerConfig;
  private readonly prisma: PrismaClient;
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly createPanelClient: ProvisioningPanelClientFactory;

  public constructor(dependencies: WorkerProcessorDependencies) {
    this.config = dependencies.config;
    this.prisma = dependencies.prisma;
    this.workerId = dependencies.workerId;
    this.now = dependencies.now ?? (() => new Date());
    this.createPanelClient = dependencies.createPanelClient ?? ((baseUrl, apiToken) => (
      new ThreeXUiClient({ baseUrl, apiToken })
    ));
  }

  public async provisioningEnabled(): Promise<boolean> {
    if (!this.config.PANEL_MUTATIONS_ENABLED) return false;
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { panelMutationsEnabled: true },
    });
    return settings?.panelMutationsEnabled === true;
  }

  public async claimEvent(): Promise<{ id: string; eventType: string; payload: unknown } | null> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.config.WORKER_LEASE_SECONDS * 1_000);
    return this.prisma.$transaction(async (transaction) => {
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
        data: {
          leaseOwner: this.workerId,
          leaseExpiresAt,
          attempts: { increment: 1 },
        },
      });
      return claimed.count === 1 ? candidate : null;
    });
  }

  public async processEvent(eventId: string, eventType: string, payload: unknown): Promise<void> {
    if (eventType !== ORDER_PROVISIONING_REQUESTED) {
      await this.markEventProcessed(eventId);
      return;
    }
    const parsed = parseProvisioningPayload(payload);
    if (!parsed) {
      await this.failEvent(eventId, "invalid_event_payload", false);
      return;
    }
    try {
      const outcome = await this.provisionOrder(parsed.orderId, parsed.provisioningJobId);
      if (outcome === "completed") await this.markEventProcessed(eventId);
      else await this.releaseEvent(eventId);
    } catch (error) {
      await this.failEvent(eventId, safeWorkerError(error), isRetryable(error));
    }
  }

  public async provisionOrder(orderId: string, jobId: string): Promise<ProvisioningOutcome> {
    const job = await this.prisma.provisioningJob.findUnique({
      where: { id: jobId },
      include: {
        order: {
          include: {
            user: true,
            plan: {
              include: {
                eligibleInbounds: {
                  include: { panelInbound: { include: { panel: true } } },
                },
              },
            },
            subscription: true,
          },
        },
      },
    });
    if (!job || job.orderId !== orderId) throw new Error("Provisioning job not found");
    if (job.status === "provisioned" || job.status === "delivered") return "completed";
    if (!await this.provisioningEnabled()) return "deferred";

    const claimTime = this.now();
    const leaseExpiresAt = new Date(
      claimTime.getTime() + this.config.WORKER_LEASE_SECONDS * 1_000,
    );
    const claimed = await this.prisma.provisioningJob.updateMany({
      where: {
        id: job.id,
        status: { in: ["queued", "failed", "manual_review"] },
        nextAttemptAt: { lte: claimTime },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: claimTime } }],
      },
      data: {
        status: "running",
        leaseOwner: this.workerId,
        leaseExpiresAt,
        lockedAt: claimTime,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return "deferred";

    const candidate = selectInbound(
      job.order.plan.eligibleInbounds.map((eligible) => eligible.panelInbound),
      claimTime,
    );
    if (!candidate) {
      throw new ManualReviewError("No healthy plan-eligible inbound is available");
    }
    const panel = candidate.panel;
    const token = decryptSecret({
      ciphertext: panel.apiTokenEncrypted,
      masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "panel-token",
      context: panel.baseUrl,
      expectedKeyId: panel.apiTokenKeyId,
    });
    const client = this.createPanelClient(panel.baseUrl, token);
    const remoteClientEmail = deterministicClientEmail(orderId);
    const existing = await this.getExistingClient(client, remoteClientEmail);
    const expiresAt = new Date(claimTime.getTime() + job.order.durationDays * 86_400_000);
    const trafficBytes = safeExternalInteger(job.order.trafficBytes, "trafficBytes");
    const telegramId = safeExternalInteger(job.order.user.telegramId, "telegramId");
    if (!existing) {
      await client.createClient({
        email: remoteClientEmail,
        inboundIds: [candidate.remoteId],
        expiryTime: expiresAt.getTime(),
        totalGB: trafficBytes,
        limitIp: job.order.deviceLimit,
        telegramId,
        comment: `hollowcon:${orderId}`,
      });
    }
    const verified = await client.getClient(remoteClientEmail);
    const links = await client.clientLinks(remoteClientEmail);
    if (links.length === 0) {
      throw new ManualReviewError("3x-ui returned no subscription links");
    }
    const encryptedLinks = encryptSecret({
      plaintext: JSON.stringify(links),
      masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "subscription-links",
      context: orderId,
    });
    const provisionedAt = this.now();

    await this.prisma.$transaction(async (transaction) => {
      const subscription = await transaction.subscription.upsert({
        where: { orderId },
        create: {
          userId: job.order.userId,
          orderId,
          panelId: panel.id,
          panelInboundId: candidate.id,
          remoteClientEmail,
          remoteSubId: verified.subId ?? null,
          status: "active",
          trafficBytes: job.order.trafficBytes,
          expiresAt,
          linksEncrypted: encryptedLinks.ciphertext,
          linksKeyId: encryptedLinks.keyId,
          provisionedAt,
        },
        update: {
          remoteSubId: verified.subId ?? null,
          status: "active",
          trafficBytes: job.order.trafficBytes,
          expiresAt,
          linksEncrypted: encryptedLinks.ciphertext,
          linksKeyId: encryptedLinks.keyId,
          provisionedAt,
        },
      });
      await transaction.provisioningJob.update({
        where: { id: job.id },
        data: {
          status: "provisioned",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorSafe: null,
        },
      });
      await transaction.notification.upsert({
        where: { idempotencyKey: `subscription-delivered:${orderId}` },
        create: {
          userId: job.order.userId,
          channel: "telegram",
          template: "subscription.delivered",
          payload: { orderId, subscriptionId: subscription.id },
          idempotencyKey: `subscription-delivered:${orderId}`,
        },
        update: {},
      });
      await transaction.auditEvent.create({
        data: {
          action: "subscription.provisioned",
          subjectType: "order",
          subjectId: orderId,
          correlationId: this.workerId,
          metadata: {
            panelId: panel.id,
            panelInboundId: candidate.id,
            remoteClientEmail,
          },
        },
      });
    });
    return "completed";
  }

  public async recoverExpiredLeases(): Promise<void> {
    const now = this.now();
    await Promise.all([
      this.prisma.outboxEvent.updateMany({
        where: { processedAt: null, leaseExpiresAt: { lt: now } },
        data: { leaseOwner: null, leaseExpiresAt: null },
      }),
      this.prisma.provisioningJob.updateMany({
        where: { status: "running", leaseExpiresAt: { lt: now } },
        data: {
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
        },
      }),
    ]);
  }

  private async getExistingClient(
    client: ProvisioningPanelClient,
    email: string,
  ): Promise<{ readonly subId?: string | null | undefined } | null> {
    try {
      return await client.getClient(email);
    } catch (error: unknown) {
      if (error instanceof ThreeXUiError && error.status === 404) return null;
      throw error;
    }
  }

  private async markEventProcessed(eventId: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id: eventId, leaseOwner: this.workerId },
      data: {
        processedAt: this.now(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorSafe: null,
      },
    });
  }

  private async releaseEvent(eventId: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id: eventId, leaseOwner: this.workerId, processedAt: null },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  private async failEvent(eventId: string, error: string, retryable: boolean): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!event || event.leaseOwner !== this.workerId) return;
    const exhausted = !retryable || event.attempts >= this.config.WORKER_MAX_ATTEMPTS;
    const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(event.attempts, 10));
    const now = this.now();
    const availableAt = new Date(now.getTime() + delay);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.outboxEvent.update({
        where: { id: event.id },
        data: exhausted
          ? {
              processedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorSafe: error,
            }
          : {
              availableAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorSafe: error,
            },
      });
      const orderId = parseOrderId(event.payload);
      if (!orderId) return;
      await transaction.provisioningJob.updateMany({
        where: { idempotencyKey: `provision-order:${orderId}` },
        data: exhausted
          ? {
              status: "manual_review",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorSafe: error,
            }
          : {
              status: "failed",
              nextAttemptAt: availableAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorSafe: error,
            },
      });
    });
  }
}
