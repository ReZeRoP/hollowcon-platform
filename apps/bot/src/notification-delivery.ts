import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "@hollowcon/config";
import { decryptSecret } from "@hollowcon/security";

import {
  notificationFailure,
  parseDeliveryPayload,
  parseLinks,
  parseMessageIds,
  safeTelegramError,
} from "./notification-logic.js";

type Locale = "fa" | "en";
type NotificationConfig = Pick<
  AppConfig,
  | "PANEL_CREDENTIAL_MASTER_KEY"
  | "TELEGRAM_MINI_APP_URL"
  | "WORKER_LEASE_SECONDS"
  | "WORKER_MAX_ATTEMPTS"
>;

export interface TelegramDeliveryClient {
  sendMessage(
    chatId: string,
    message: string,
    options?: { readonly webAppText: string; readonly webAppUrl: string },
  ): Promise<{ readonly messageId: number }>;
  sendPhoto(
    chatId: string,
    image: Uint8Array,
    fileName: string,
    caption: string,
  ): Promise<{ readonly messageId: number }>;
}

export interface NotificationDeliveryDependencies {
  readonly config: NotificationConfig;
  readonly prisma: PrismaClient;
  readonly workerId: string;
  readonly telegram: TelegramDeliveryClient;
  readonly renderQr: (link: string) => Promise<Uint8Array>;
  readonly now?: () => Date;
}

export class NotificationDeliveryProcessor {
  private readonly config: NotificationConfig;
  private readonly prisma: PrismaClient;
  private readonly workerId: string;
  private readonly telegram: TelegramDeliveryClient;
  private readonly renderQr: (link: string) => Promise<Uint8Array>;
  private readonly now: () => Date;

  public constructor(dependencies: NotificationDeliveryDependencies) {
    this.config = dependencies.config;
    this.prisma = dependencies.prisma;
    this.workerId = dependencies.workerId;
    this.telegram = dependencies.telegram;
    this.renderQr = dependencies.renderQr;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async claimNotification(): Promise<{ id: string } | null> {
    const now = this.now();
    const leaseExpiresAt = new Date(
      now.getTime() + this.config.WORKER_LEASE_SECONDS * 1_000,
    );
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.notification.findFirst({
        where: {
          channel: "telegram",
          status: { in: ["pending", "failed"] },
          availableAt: { lte: now },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!candidate) return null;
      const claimed = await transaction.notification.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["pending", "failed"] },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "sending",
          leaseOwner: this.workerId,
          leaseExpiresAt,
          attempts: { increment: 1 },
        },
      });
      return claimed.count === 1 ? candidate : null;
    });
  }

  public async deliverNotification(notificationId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: { user: true },
    });
    if (!notification || notification.leaseOwner !== this.workerId) return;
    const payload = parseDeliveryPayload(notification.payload);
    if (!payload) {
      await this.failNotification(notification.id, "invalid_notification_payload", false);
      return;
    }
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: payload.subscriptionId, userId: notification.userId },
      include: { order: true },
    });
    if (!subscription?.linksEncrypted) {
      await this.failNotification(notification.id, "subscription_links_unavailable", false);
      return;
    }
    let links: string[];
    try {
      links = parseLinks(decryptSecret({
        ciphertext: subscription.linksEncrypted,
        masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
        purpose: "subscription-links",
        context: subscription.orderId,
        ...(subscription.linksKeyId
          ? { expectedKeyId: subscription.linksKeyId }
          : {}),
      }));
    } catch {
      await this.failNotification(notification.id, "subscription_links_invalid", false);
      return;
    }
    if (links.length === 0) {
      await this.failNotification(notification.id, "subscription_links_empty", false);
      return;
    }

    const locale = notification.user.locale;
    const chatId = notification.user.telegramId.toString();
    const messageIds = parseMessageIds(notification.messageIds);
    let step = notification.deliveryStep;
    try {
      if (step === 0) {
        const sent = await this.telegram.sendMessage(
          chatId,
          [
            deliveryText(locale, "delivered"),
            `${locale === "fa" ? "انقضا" : "Expires"}: ${subscription.expiresAt.toISOString()}`,
          ].join("\n\n"),
          {
            webAppText: deliveryText(locale, "miniApp"),
            webAppUrl: this.config.TELEGRAM_MINI_APP_URL,
          },
        );
        messageIds.push(sent.messageId);
        step = 1;
        await this.saveProgress(notification.id, step, messageIds);
      }
      for (const [index, link] of links.entries()) {
        const linkStep = 1 + index * 2;
        if (step === linkStep) {
          const sent = await this.telegram.sendMessage(
            chatId,
            `${deliveryText(locale, "config")} ${index + 1}:\n${link}`,
          );
          messageIds.push(sent.messageId);
          step += 1;
          await this.saveProgress(notification.id, step, messageIds);
        }
        if (step === linkStep + 1) {
          const qr = await this.renderQr(link);
          const sent = await this.telegram.sendPhoto(
            chatId,
            qr,
            `hollowcon-${index + 1}.png`,
            `${deliveryText(locale, "qr")} ${index + 1}`,
          );
          messageIds.push(sent.messageId);
          step += 1;
          await this.saveProgress(notification.id, step, messageIds);
        }
      }
      const deliveredAt = this.now();
      await this.prisma.$transaction(async (transaction) => {
        await transaction.notification.update({
          where: { id: notification.id },
          data: {
            status: "delivered",
            deliveredAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorSafe: null,
          },
        });
        await transaction.subscription.update({
          where: { id: subscription.id },
          data: { deliveredAt },
        });
        await transaction.auditEvent.create({
          data: {
            action: "subscription.delivered",
            subjectType: "subscription",
            subjectId: subscription.id,
            correlationId: this.workerId,
            metadata: {
              notificationId: notification.id,
              telegramMessageCount: messageIds.length,
            },
          },
        });
      });
    } catch (error) {
      await this.failNotification(notification.id, safeTelegramError(error), true);
    }
  }

  public async recoverExpiredLeases(): Promise<void> {
    const now = this.now();
    await this.prisma.notification.updateMany({
      where: { status: "sending", leaseExpiresAt: { lt: now } },
      data: {
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: now,
      },
    });
  }

  private async saveProgress(
    notificationId: string,
    deliveryStep: number,
    messageIds: number[],
  ): Promise<void> {
    const saved = await this.prisma.notification.updateMany({
      where: { id: notificationId, leaseOwner: this.workerId },
      data: { deliveryStep, messageIds },
    });
    if (saved.count !== 1) throw new Error("Notification delivery lease was lost");
  }

  private async failNotification(
    notificationId: string,
    error: string,
    retryable: boolean,
  ): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification || notification.leaseOwner !== this.workerId) return;
    const outcome = notificationFailure(
      notification.attempts,
      this.config.WORKER_MAX_ATTEMPTS,
      retryable,
      this.now(),
    );
    await this.prisma.notification.update({
      where: { id: notification.id },
      data: outcome.status === "manual_review"
        ? {
            status: "manual_review",
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorSafe: error,
          }
        : {
            status: "failed",
            availableAt: outcome.availableAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorSafe: error,
          },
    });
  }
}

function deliveryText(
  locale: Locale,
  key: "delivered" | "miniApp" | "config" | "qr",
): string {
  const translations = {
    fa: {
      delivered: "سرویس شما آماده است. لینک‌ها و کدهای QR را محرمانه نگه دارید.",
      miniApp: "باز کردن مینی‌اپ",
      config: "لینک اتصال",
      qr: "کد QR اتصال",
    },
    en: {
      delivered: "Your service is ready. Keep connection links and QR codes private.",
      miniApp: "Open Mini App",
      config: "Connection link",
      qr: "Connection QR code",
    },
  } as const;
  return translations[locale][key];
}
