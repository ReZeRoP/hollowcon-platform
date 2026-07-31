import type { PrismaClient } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@hollowcon/security";
import { ThreeXUiError, type CreateClientInput } from "@hollowcon/three-x-ui";
import { describe, expect, it, vi } from "vitest";

import {
  WorkerProcessor,
  type ProvisioningPanelClient,
} from "./processor.js";

const NOW = new Date("2026-07-31T00:00:00.000Z");
const MASTER_KEY = "worker-integration-master-key-at-least-32-chars";
const WORKER_ID = "worker:test";
const ORDER_ID = "order-1";
const JOB_ID = "job-1";
const EVENT_ID = "event-1";
const REMOTE_EMAIL = "hc-order-1@hollowcon.invalid";

interface HarnessOptions {
  readonly environmentGate?: boolean;
  readonly databaseGate?: boolean;
  readonly claimCount?: number;
  readonly eventAttempts?: number;
  readonly maxAttempts?: number;
  readonly firstClientResult?: "missing" | "existing" | "retryable" | "manual";
  readonly links?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  const encryptedToken = encryptSecret({
    plaintext: "panel-api-token",
    masterKey: MASTER_KEY,
    purpose: "panel-token",
    context: "https://panel.example.com",
  });
  const job = {
    id: JOB_ID,
    orderId: ORDER_ID,
    status: "queued",
    order: {
      id: ORDER_ID,
      userId: "user-1",
      durationDays: 30,
      trafficBytes: 50_000_000_000n,
      deviceLimit: 2,
      user: { telegramId: 12_345n },
      subscription: null,
      plan: {
        eligibleInbounds: [{
          panelInbound: {
            id: "inbound-1",
            remoteId: 7,
            enabled: true,
            activeClients: 5,
            capacity: 100,
            panel: {
              id: "panel-1",
              baseUrl: "https://panel.example.com",
              apiTokenEncrypted: encryptedToken.ciphertext,
              apiTokenKeyId: encryptedToken.keyId,
              enabled: true,
              circuitOpenUntil: null,
            },
          },
        }],
      },
    },
  };
  const event = {
    id: EVENT_ID,
    eventType: "order.provisioning.requested",
    payload: { orderId: ORDER_ID, provisioningJobId: JOB_ID },
    leaseOwner: WORKER_ID,
    attempts: options.eventAttempts ?? 1,
  };

  const subscriptionUpsert = vi.fn().mockResolvedValue({ id: "subscription-1" });
  const provisioningUpdate = vi.fn().mockResolvedValue({});
  const provisioningUpdateMany = vi.fn().mockResolvedValue({ count: options.claimCount ?? 1 });
  const notificationUpsert = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  const outboxUpdate = vi.fn().mockResolvedValue({});
  const outboxUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const systemSettingsFindUnique = vi.fn().mockResolvedValue({
    panelMutationsEnabled: options.databaseGate ?? true,
  });

  const prismaLike = {
    systemSettings: { findUnique: systemSettingsFindUnique },
    provisioningJob: {
      findUnique: vi.fn().mockResolvedValue(job),
      updateMany: provisioningUpdateMany,
      update: provisioningUpdate,
    },
    outboxEvent: {
      findFirst: vi.fn().mockResolvedValue(event),
      findUnique: vi.fn().mockResolvedValue(event),
      updateMany: outboxUpdateMany,
      update: outboxUpdate,
    },
    subscription: { upsert: subscriptionUpsert },
    notification: { upsert: notificationUpsert },
    auditEvent: { create: auditCreate },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => (
      callback(prismaLike)
    )),
  };

  const firstClientResult = options.firstClientResult ?? "missing";
  const getClient = vi.fn();
  if (firstClientResult === "missing") {
    getClient
      .mockRejectedValueOnce(new ThreeXUiError("not found", 404))
      .mockResolvedValue({ email: REMOTE_EMAIL, subId: "sub-1" });
  } else if (firstClientResult === "existing") {
    getClient.mockResolvedValue({ email: REMOTE_EMAIL, subId: "sub-existing" });
  } else if (firstClientResult === "retryable") {
    getClient.mockRejectedValue(new ThreeXUiError("unavailable", 503));
  } else {
    getClient.mockRejectedValue(new ThreeXUiError("invalid", 400));
  }
  const createClient = vi.fn().mockResolvedValue({});
  const clientLinks = vi.fn().mockResolvedValue(
    options.links ?? ["vless://first", "trojan://second"],
  );
  const panelClient: ProvisioningPanelClient = {
    getClient,
    createClient,
    clientLinks,
  };
  const createPanelClient = vi.fn().mockReturnValue(panelClient);

  const processor = new WorkerProcessor({
    config: {
      PANEL_CREDENTIAL_MASTER_KEY: MASTER_KEY,
      PANEL_MUTATIONS_ENABLED: options.environmentGate ?? true,
      WORKER_LEASE_SECONDS: 120,
      WORKER_MAX_ATTEMPTS: options.maxAttempts ?? 8,
    },
    prisma: prismaLike as unknown as PrismaClient,
    workerId: WORKER_ID,
    now: () => new Date(NOW),
    createPanelClient,
  });

  return {
    processor,
    job,
    event,
    mocks: {
      auditCreate,
      clientLinks,
      createClient,
      createPanelClient,
      getClient,
      notificationUpsert,
      outboxUpdate,
      outboxUpdateMany,
      provisioningUpdate,
      provisioningUpdateMany,
      subscriptionUpsert,
      systemSettingsFindUnique,
    },
  };
}

describe("worker provisioning integration", () => {
  it("creates, verifies, stores, and queues delivery for a missing deterministic client", async () => {
    const harness = createHarness();

    await expect(harness.processor.provisionOrder(ORDER_ID, JOB_ID)).resolves.toBe("completed");

    expect(harness.mocks.createPanelClient).toHaveBeenCalledWith(
      "https://panel.example.com",
      "panel-api-token",
    );
    expect(harness.mocks.getClient).toHaveBeenNthCalledWith(1, REMOTE_EMAIL);
    expect(harness.mocks.getClient).toHaveBeenNthCalledWith(2, REMOTE_EMAIL);
    expect(harness.mocks.createClient).toHaveBeenCalledWith({
      email: REMOTE_EMAIL,
      inboundIds: [7],
      expiryTime: new Date("2026-08-30T00:00:00.000Z").getTime(),
      totalGB: 50_000_000_000,
      limitIp: 2,
      telegramId: 12_345,
      comment: "hollowcon:order-1",
    } satisfies CreateClientInput);
    const subscriptionCall = harness.mocks.subscriptionUpsert.mock.calls[0]?.[0] as {
      create: { linksEncrypted: string; linksKeyId: string };
    };
    expect(JSON.parse(decryptSecret({
      ciphertext: subscriptionCall.create.linksEncrypted,
      masterKey: MASTER_KEY,
      purpose: "subscription-links",
      context: ORDER_ID,
      expectedKeyId: subscriptionCall.create.linksKeyId,
    }))).toEqual(["vless://first", "trojan://second"]);
    expect(harness.mocks.notificationUpsert).toHaveBeenCalledOnce();
    expect(harness.mocks.auditCreate).toHaveBeenCalledOnce();
  });

  it("recovers after a crash by reusing the deterministic existing client", async () => {
    const harness = createHarness({ firstClientResult: "existing" });

    await expect(harness.processor.provisionOrder(ORDER_ID, JOB_ID)).resolves.toBe("completed");

    expect(harness.mocks.getClient).toHaveBeenCalledTimes(2);
    expect(harness.mocks.createClient).not.toHaveBeenCalled();
    expect(harness.mocks.subscriptionUpsert).toHaveBeenCalledOnce();
  });

  it("defers before claiming when either panel mutation gate is disabled", async () => {
    const environmentDisabled = createHarness({ environmentGate: false });
    await expect(environmentDisabled.processor.provisionOrder(ORDER_ID, JOB_ID)).resolves.toBe("deferred");
    expect(environmentDisabled.mocks.systemSettingsFindUnique).not.toHaveBeenCalled();
    expect(environmentDisabled.mocks.provisioningUpdateMany).not.toHaveBeenCalled();

    const databaseDisabled = createHarness({ databaseGate: false });
    await expect(databaseDisabled.processor.provisionOrder(ORDER_ID, JOB_ID)).resolves.toBe("deferred");
    expect(databaseDisabled.mocks.provisioningUpdateMany).not.toHaveBeenCalled();
  });

  it("defers when another worker wins the provisioning lease race", async () => {
    const harness = createHarness({ claimCount: 0 });

    await expect(harness.processor.provisionOrder(ORDER_ID, JOB_ID)).resolves.toBe("deferred");

    expect(harness.mocks.createPanelClient).not.toHaveBeenCalled();
    expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
  });

  it("releases the outbox lease when provisioning is deferred", async () => {
    const harness = createHarness({ databaseGate: false });

    await harness.processor.processEvent(
      EVENT_ID,
      "order.provisioning.requested",
      harness.event.payload,
    );

    expect(harness.mocks.outboxUpdateMany).toHaveBeenCalledWith({
      where: { id: EVENT_ID, leaseOwner: WORKER_ID, processedAt: null },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  });

  it("schedules both the event and job for retry after a retryable 3x-ui failure", async () => {
    const harness = createHarness({ firstClientResult: "retryable" });

    await harness.processor.processEvent(
      EVENT_ID,
      "order.provisioning.requested",
      harness.event.payload,
    );

    const outboxRetry = harness.mocks.outboxUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { availableAt: Date; lastErrorSafe: string; processedAt?: Date };
    };
    expect(outboxRetry.where).toEqual({ id: EVENT_ID });
    expect(outboxRetry.data.availableAt).toEqual(new Date("2026-07-31T00:00:02.000Z"));
    expect(outboxRetry.data.lastErrorSafe).toBe("3x-ui:503");
    expect(outboxRetry.data.processedAt).toBeUndefined();

    const jobRetry = harness.mocks.provisioningUpdateMany.mock.calls.at(-1)?.[0] as {
      where: { idempotencyKey: string };
      data: { status: string; nextAttemptAt: Date; lastErrorSafe: string };
    };
    expect(jobRetry.where).toEqual({ idempotencyKey: "provision-order:order-1" });
    expect(jobRetry.data.status).toBe("failed");
    expect(jobRetry.data.nextAttemptAt).toEqual(new Date("2026-07-31T00:00:02.000Z"));
    expect(jobRetry.data.lastErrorSafe).toBe("3x-ui:503");
  });

  it("moves permanent or exhausted failures to manual review", async () => {
    const permanent = createHarness({ firstClientResult: "manual" });
    await permanent.processor.processEvent(
      EVENT_ID,
      "order.provisioning.requested",
      permanent.event.payload,
    );
    const permanentOutbox = permanent.mocks.outboxUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { processedAt: Date; lastErrorSafe: string };
    };
    expect(permanentOutbox.where).toEqual({ id: EVENT_ID });
    expect(permanentOutbox.data.processedAt).toEqual(NOW);
    expect(permanentOutbox.data.lastErrorSafe).toBe("3x-ui:400");
    const permanentJob = permanent.mocks.provisioningUpdateMany.mock.calls.at(-1)?.[0] as {
      where: { idempotencyKey: string };
      data: { status: string };
    };
    expect(permanentJob.where).toEqual({ idempotencyKey: "provision-order:order-1" });
    expect(permanentJob.data.status).toBe("manual_review");

    const exhausted = createHarness({
      firstClientResult: "retryable",
      eventAttempts: 8,
      maxAttempts: 8,
    });
    await exhausted.processor.processEvent(
      EVENT_ID,
      "order.provisioning.requested",
      exhausted.event.payload,
    );
    const exhaustedJob = exhausted.mocks.provisioningUpdateMany.mock.calls.at(-1)?.[0] as {
      where: { idempotencyKey: string };
      data: { status: string };
    };
    expect(exhaustedJob.where).toEqual({ idempotencyKey: "provision-order:order-1" });
    expect(exhaustedJob.data.status).toBe("manual_review");
  });

  it("does not persist an unusable subscription with no connection links", async () => {
    const harness = createHarness({ links: [] });

    await expect(harness.processor.provisionOrder(ORDER_ID, JOB_ID)).rejects.toThrow(
      "3x-ui returned no subscription links",
    );

    expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
  });
});
