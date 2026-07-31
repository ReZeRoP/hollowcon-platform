import type { PrismaClient } from "@prisma/client";
import { encryptSecret } from "@hollowcon/security";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationDeliveryProcessor,
  type TelegramDeliveryClient,
} from "./notification-delivery.js";

const NOW = new Date("2026-07-31T00:00:00.000Z");
const MASTER_KEY = "notification-integration-master-key-at-least-32-chars";
const WORKER_ID = "bot:test";
const NOTIFICATION_ID = "notification-1";

interface HarnessOptions {
  readonly deliveryStep?: number;
  readonly messageIds?: number[];
  readonly attempts?: number;
  readonly progressCount?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const encrypted = encryptSecret({
    plaintext: JSON.stringify(["vless://one", "trojan://two"]),
    masterKey: MASTER_KEY,
    purpose: "subscription-links",
    context: "order-1",
  });
  const notification = {
    id: NOTIFICATION_ID,
    userId: "user-1",
    leaseOwner: WORKER_ID,
    attempts: options.attempts ?? 1,
    payload: { subscriptionId: "subscription-1" },
    deliveryStep: options.deliveryStep ?? 0,
    messageIds: options.messageIds ?? [],
    user: { telegramId: 12345n, locale: "en" },
  };
  const subscription = {
    id: "subscription-1",
    userId: "user-1",
    orderId: "order-1",
    expiresAt: new Date("2026-08-30T00:00:00.000Z"),
    linksEncrypted: encrypted.ciphertext,
    linksKeyId: encrypted.keyId,
  };

  const notificationFindUnique = vi.fn().mockResolvedValue(notification);
  const notificationUpdateMany = vi.fn().mockResolvedValue({
    count: options.progressCount ?? 1,
  });
  const notificationUpdate = vi.fn().mockResolvedValue({});
  const subscriptionFindFirst = vi.fn().mockResolvedValue(subscription);
  const subscriptionUpdate = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  const prismaLike = {
    notification: {
      findFirst: vi.fn().mockResolvedValue({ id: NOTIFICATION_ID }),
      findUnique: notificationFindUnique,
      updateMany: notificationUpdateMany,
      update: notificationUpdate,
    },
    subscription: {
      findFirst: subscriptionFindFirst,
      update: subscriptionUpdate,
    },
    auditEvent: { create: auditCreate },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => (
      callback(prismaLike)
    )),
  };

  let messageId = 100;
  const sendMessage = vi.fn<TelegramDeliveryClient["sendMessage"]>(
    () => Promise.resolve({ messageId: ++messageId }),
  );
  const sendPhoto = vi.fn<TelegramDeliveryClient["sendPhoto"]>(
    () => Promise.resolve({ messageId: ++messageId }),
  );
  const telegram: TelegramDeliveryClient = { sendMessage, sendPhoto };
  const renderQr = vi.fn((link: string) => (
    Promise.resolve(Buffer.from(`qr:${link}`, "utf8"))
  ));
  const processor = new NotificationDeliveryProcessor({
    config: {
      PANEL_CREDENTIAL_MASTER_KEY: MASTER_KEY,
      TELEGRAM_MINI_APP_URL: "https://hollowcon.example.com",
      WORKER_LEASE_SECONDS: 120,
      WORKER_MAX_ATTEMPTS: 5,
    },
    prisma: prismaLike as unknown as PrismaClient,
    workerId: WORKER_ID,
    telegram,
    renderQr,
    now: () => new Date(NOW),
  });

  return {
    processor,
    notification,
    mocks: {
      auditCreate,
      notificationFindUnique,
      notificationUpdate,
      notificationUpdateMany,
      renderQr,
      sendMessage,
      sendPhoto,
      subscriptionUpdate,
    },
  };
}

describe("Telegram notification delivery integration", () => {
  it("delivers summary, every link, every QR, and records final delivery", async () => {
    const harness = createHarness();

    await harness.processor.deliverNotification(NOTIFICATION_ID);

    expect(harness.mocks.sendMessage).toHaveBeenCalledTimes(3);
    expect(harness.mocks.sendPhoto).toHaveBeenCalledTimes(2);
    expect(harness.mocks.sendMessage.mock.calls[0]?.[2]).toEqual({
      webAppText: "Open Mini App",
      webAppUrl: "https://hollowcon.example.com",
    });
    expect(harness.mocks.sendMessage.mock.calls[1]?.[1]).toContain("vless://one");
    expect(harness.mocks.sendMessage.mock.calls[2]?.[1]).toContain("trojan://two");
    expect(harness.mocks.notificationUpdateMany).toHaveBeenCalledTimes(5);
    expect(harness.mocks.subscriptionUpdate).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: { deliveredAt: NOW },
    });
    expect(harness.mocks.auditCreate).toHaveBeenCalledOnce();
  });

  it("resumes after an interruption without repeating completed Telegram sends", async () => {
    const harness = createHarness({ deliveryStep: 2, messageIds: [101, 102] });

    await harness.processor.deliverNotification(NOTIFICATION_ID);

    expect(harness.mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.mocks.sendMessage.mock.calls[0]?.[1]).toContain("trojan://two");
    expect(harness.mocks.sendPhoto).toHaveBeenCalledTimes(2);
    expect(harness.mocks.notificationUpdateMany).toHaveBeenCalledTimes(3);
  });

  it("persists progress before attempting the next delivery step", async () => {
    const harness = createHarness();
    harness.mocks.sendMessage
      .mockResolvedValueOnce({ messageId: 101 })
      .mockRejectedValueOnce(new Error("network details"));

    await harness.processor.deliverNotification(NOTIFICATION_ID);

    const firstProgress = harness.mocks.notificationUpdateMany.mock.calls[0]?.[0] as {
      data: { deliveryStep: number; messageIds: number[] };
    };
    expect(firstProgress.data).toEqual({ deliveryStep: 1, messageIds: [101] });
    const failure = harness.mocks.notificationUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: string; availableAt: Date; lastErrorSafe: string };
    };
    expect(failure.data.status).toBe("failed");
    expect(failure.data.availableAt).toEqual(new Date("2026-07-31T00:00:02.000Z"));
    expect(failure.data.lastErrorSafe).toBe("Error");
  });

  it("moves exhausted Telegram delivery retries to manual review", async () => {
    const harness = createHarness({ attempts: 5 });
    harness.mocks.sendMessage.mockRejectedValue(new Error("network details"));

    await harness.processor.deliverNotification(NOTIFICATION_ID);

    const failure = harness.mocks.notificationUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: string; lastErrorSafe: string };
    };
    expect(failure.data.status).toBe("manual_review");
    expect(failure.data.lastErrorSafe).toBe("Error");
  });

  it("stops duplicate delivery when the notification lease belongs to another worker", async () => {
    const harness = createHarness();
    harness.notification.leaseOwner = "bot:other";

    await harness.processor.deliverNotification(NOTIFICATION_ID);

    expect(harness.mocks.sendMessage).not.toHaveBeenCalled();
    expect(harness.mocks.sendPhoto).not.toHaveBeenCalled();
  });

  it("treats lost progress leases as retryable interruptions", async () => {
    const harness = createHarness({ progressCount: 0 });

    await harness.processor.deliverNotification(NOTIFICATION_ID);

    expect(harness.mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.mocks.notificationUpdate).toHaveBeenCalledOnce();
    const failure = harness.mocks.notificationUpdate.mock.calls[0]?.[0] as {
      data: { status: string; lastErrorSafe: string };
    };
    expect(failure.data.status).toBe("failed");
    expect(failure.data.lastErrorSafe).toBe("Error");
  });
});
