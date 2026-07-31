import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  CommerceConflictError,
  CommerceNotFoundError,
  CommercePermissionError,
  CommerceService,
  CommerceValidationError,
} from "@hollowcon/commerce";
import {
  createOrderRequestSchema,
  paymentReviewRequestSchema,
  setupCardSchema,
  setupEligibilitySchema,
  setupFinalizeSchema,
  setupPanelSchema,
  setupPlanSchema,
  telegramAuthRequestSchema,
  updateCardSchema,
  updateInboundSchema,
  updatePanelSchema,
  updatePlanSchema,
} from "@hollowcon/contracts";
import type { AppConfig } from "@hollowcon/config";
import { decryptSecret, encryptSecret, maskIranianPan, panLastFour } from "@hollowcon/security";
import { verifyTelegramInitData, type TelegramInitData } from "@hollowcon/telegram";
import { ThreeXUiClient } from "@hollowcon/three-x-ui";
import QRCode from "qrcode";
import type { RedisClientType } from "redis";
import { z } from "zod";

import {
  ApiError,
  createContext,
  parseCookies,
  readJson,
  requireSameOrigin,
  sendApiError,
  sendJson,
} from "./lib/http.js";
import { enforceRateLimit, requestIdentity, type RateLimitPolicy } from "./lib/rate-limit.js";
import { removeStoredReceipt, resolveStoragePath, storeReceipt } from "./lib/receipts.js";
import {
  authenticateSession,
  clearSessionCookies,
  createSession,
  csrfCookie,
  CSRF_COOKIE,
  requireRole,
  sessionCookie,
  SESSION_COOKIE,
  verifyCsrfToken,
} from "./lib/sessions.js";

const AUTH_RATE_LIMIT = {
  name: "telegram-auth",
  limit: 12,
  windowSeconds: 60,
} as const satisfies RateLimitPolicy;
const CUSTOMER_MUTATION_RATE_LIMIT = {
  name: "customer-mutation",
  limit: 30,
  windowSeconds: 60,
} as const satisfies RateLimitPolicy;
const STAFF_MUTATION_RATE_LIMIT = {
  name: "staff-mutation",
  limit: 60,
  windowSeconds: 60,
} as const satisfies RateLimitPolicy;

type Authenticated = Awaited<ReturnType<typeof authenticateSession>>;
type ApiRedisClient = Pick<RedisClientType, "incr" | "expire" | "ping"> & {
  readonly isReady: boolean;
};
type TelegramVerifier = (
  initData: string,
  botToken: string,
  now: Date,
  maxAgeSeconds: number,
) => TelegramInitData;

export interface PanelProbeResult {
  readonly version?: string;
  readonly inbounds: ReadonlyArray<{
    readonly id: number;
    readonly tag: string;
    readonly remark: string;
    readonly protocol: string;
    readonly port: number;
  }>;
}

type PanelProbe = (baseUrl: string, apiToken: string) => Promise<PanelProbeResult>;

export interface ApiDependencies {
  readonly config: AppConfig;
  readonly prisma: PrismaClient;
  readonly commerce?: CommerceService;
  readonly redis: ApiRedisClient;
  readonly verifyTelegram?: TelegramVerifier;
  readonly probePanel?: PanelProbe;
}

export function createApiServer(dependencies: ApiDependencies): Server {
  const app = new ApiApplication(dependencies);
  return createServer((request, response) => {
    void app.handleRequest(request, response);
  });
}

class ApiApplication {
  private readonly config: AppConfig;
  private readonly prisma: PrismaClient;
  private readonly commerce: CommerceService;
  private readonly redis: ApiRedisClient;
  private readonly verifyTelegram: TelegramVerifier;
  private readonly probePanel: PanelProbe;

  public constructor(dependencies: ApiDependencies) {
    this.config = dependencies.config;
    this.prisma = dependencies.prisma;
    this.commerce = dependencies.commerce ?? new CommerceService(dependencies.prisma);
    this.redis = dependencies.redis;
    this.verifyTelegram = dependencies.verifyTelegram ?? verifyTelegramInitData;
    this.probePanel =
      dependencies.probePanel ??
      (async (baseUrl, apiToken) => {
        const client = new ThreeXUiClient({ baseUrl, apiToken });
        return client.testConnection();
      });
  }

  public async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const context = createContext(request, response);
    try {
      const url = new URL(request.url ?? "/", this.config.PUBLIC_BASE_URL);
      if (
        request.method === "GET" &&
        (url.pathname === "/health/live" || url.pathname === "/api/health/live")
      ) {
        sendJson(response, 200, { status: "ok", service: "api" });
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/health/ready" || url.pathname === "/api/health/ready")
      ) {
        await this.prisma.$queryRaw`SELECT 1`;
        if (!this.redis.isReady) throw new ApiError(503, "redis_unavailable", "Redis is not ready");
        await this.redis.ping();
        sendJson(response, 200, { status: "ready", service: "api" });
        return;
      }
      await this.route(context, url);
    } catch (error) {
      sendApiError(context, translateError(error));
    }
  }

  private async route(context: ReturnType<typeof createContext>, url: URL): Promise<void> {
    const { request, response } = context;
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && path === "/api/v1/installation") {
      const settings = await this.prisma.systemSettings.findUnique({ where: { id: 1 } });
      sendJson(response, 200, { setupRequired: !settings?.setupCompletedAt });
      return;
    }

    if (method === "POST" && path === "/api/v1/auth/telegram") {
      requireSameOrigin(request, this.config.PUBLIC_BASE_URL);
      await enforceRateLimit(
        this.redis,
        AUTH_RATE_LIMIT,
        requestIdentity(request.headers, request.socket.remoteAddress),
      );
      const input = telegramAuthRequestSchema.parse(await readJson(request));
      const verified = this.verifyTelegram(
        input.initData,
        this.config.TELEGRAM_BOT_TOKEN,
        new Date(),
        this.config.TELEGRAM_AUTH_MAX_AGE_SECONDS,
      );
      if (!verified.user)
        throw new ApiError(400, "telegram_user_missing", "Telegram user data is required");
      const settings = await this.prisma.systemSettings.upsert({
        where: { id: 1 },
        create: { id: 1 },
        update: {},
      });
      const initialOwner = BigInt(this.config.INITIAL_OWNER_TELEGRAM_ID);
      if (!settings.setupCompletedAt && BigInt(verified.user.id) !== initialOwner) {
        throw new ApiError(
          403,
          "owner_bootstrap_required",
          "Only the configured initial owner may complete setup",
        );
      }

      const existingUser = await this.prisma.user.findUnique({
        where: { telegramId: BigInt(verified.user.id) },
      });
      if (existingUser?.disabledAt)
        throw new ApiError(403, "account_disabled", "This account has been disabled");
      const user = await this.prisma.user.upsert({
        where: { telegramId: BigInt(verified.user.id) },
        create: {
          telegramId: BigInt(verified.user.id),
          firstName: verified.user.firstName,
          ...(verified.user.username ? { username: verified.user.username } : {}),
          locale: verified.user.languageCode?.startsWith("fa") ? "fa" : settings.defaultLocale,
          ...(BigInt(verified.user.id) === initialOwner
            ? { role: "owner", roleAssignedAt: new Date() }
            : {}),
        },
        update: {
          firstName: verified.user.firstName,
          username: verified.user.username ?? null,
        },
      });
      const session = await createSession(
        this.prisma,
        user.id,
        this.config.ADMIN_SESSION_SECRET,
        this.config.SESSION_TTL_SECONDS,
      );
      response.setHeader("set-cookie", [
        sessionCookie(session.token, session.expiresAt),
        csrfCookie(session.csrfToken, session.expiresAt),
      ]);
      sendJson(response, 200, serializeMe(user, session.csrfToken));
      return;
    }

    const auth = await this.requireAuthenticated(context, method !== "GET");
    if (method !== "GET") {
      await enforceRateLimit(
        this.redis,
        auth.user.role ? STAFF_MUTATION_RATE_LIMIT : CUSTOMER_MUTATION_RATE_LIMIT,
        auth.user.id,
      );
    }

    if (method === "GET" && path === "/api/v1/me") {
      const csrfToken = parseCookies(request).get(CSRF_COOKIE);
      if (!csrfToken) throw new ApiError(401, "invalid_session", "Your session has expired");
      sendJson(response, 200, serializeMe(auth.user, csrfToken));
      return;
    }
    if (method === "POST" && path === "/api/v1/auth/logout") {
      await this.prisma.adminSession.update({
        where: { id: auth.id },
        data: { revokedAt: new Date() },
      });
      response.setHeader("set-cookie", clearSessionCookies());
      sendJson(response, 200, { status: "signed_out" });
      return;
    }

    if (method === "GET" && path === "/api/v1/plans") {
      const plans = await this.prisma.plan.findMany({
        where: { active: true },
        orderBy: { priceRial: "asc" },
      });
      sendJson(response, 200, plans.map(serializePlan));
      return;
    }
    if (method === "POST" && path === "/api/v1/orders") {
      await this.requireOrdersEnabled(auth.user);
      const input = createOrderRequestSchema.parse(await readJson(request));
      const card = await this.prisma.recipientCard.findFirst({
        where: { active: true },
        orderBy: { createdAt: "asc" },
      });
      if (!card)
        throw new ApiError(
          409,
          "recipient_card_unavailable",
          "No payment card is currently available",
        );
      const order = await this.commerce.createOrder({
        userId: auth.user.id,
        planId: input.planId,
        recipientCardId: card.id,
        idempotencyKey: input.idempotencyKey,
        reservationMinutes: this.config.PAYMENT_RESERVATION_MINUTES,
        uniqueSuffixMin: this.config.PAYMENT_UNIQUE_SUFFIX_MIN,
        uniqueSuffixMax: this.config.PAYMENT_UNIQUE_SUFFIX_MAX,
      });
      sendJson(
        response,
        201,
        serializeOrder(
          order,
          maskIranianPan(
            decryptSecret({
              ciphertext: card.panEncrypted,
              masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
              purpose: "recipient-pan",
              context: "recipient-card",
              expectedKeyId: card.panKeyId,
            }),
          ),
        ),
      );
      return;
    }

    const orderReceiptMatch = /^\/api\/v1\/orders\/([^/]+)\/receipt$/u.exec(path);
    if (method === "POST" && orderReceiptMatch) {
      const orderId = orderReceiptMatch[1];
      if (!orderId) throw new ApiError(404, "not_found", "Route not found");
      const order = await this.prisma.order.findFirst({
        where: { id: orderId, userId: auth.user.id },
      });
      if (!order) throw new ApiError(404, "order_not_found", "Order not found");
      const stored = await storeReceipt(
        request,
        this.config.RECEIPT_STORAGE_PATH,
        this.config.RECEIPT_MAX_BYTES,
      );
      try {
        const receipt = await this.commerce.submitReceipt({
          orderId: order.id,
          storageKey: stored.storageKey,
          mediaType: stored.detectedMediaType,
          detectedMediaType: stored.detectedMediaType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          ...(stored.originalFileName ? { originalFileName: stored.originalFileName } : {}),
        });
        sendJson(response, 201, {
          id: receipt.id,
          status: "under_review",
          submittedAt: receipt.submittedAt.toISOString(),
        });
      } catch (error) {
        await removeStoredReceipt(stored.storagePath);
        throw error;
      }
      return;
    }

    const receiptMatch = /^\/api\/v1\/receipts\/([^/]+)$/u.exec(path);
    if (method === "GET" && receiptMatch) {
      const receiptId = receiptMatch[1];
      if (!receiptId) throw new ApiError(404, "not_found", "Route not found");
      const receipt = await this.prisma.paymentReceipt.findUnique({
        where: { id: receiptId },
        include: { order: true },
      });
      if (!receipt || (receipt.order.userId !== auth.user.id && !auth.user.role)) {
        throw new ApiError(404, "receipt_not_found", "Receipt not found");
      }
      if (auth.user.role) requireRole(auth.user, ["owner", "admin", "finance"]);
      await this.prisma.auditEvent.create({
        data: {
          actorId: auth.user.id,
          action: "receipt.viewed",
          subjectType: "receipt",
          subjectId: receipt.id,
          correlationId: context.correlationId,
          metadata: { orderId: receipt.orderId },
        },
      });
      response.writeHead(200, {
        "content-type": receipt.detectedMediaType,
        "content-disposition": `attachment; filename="receipt-${receipt.id}"`,
        "cache-control": "no-store, private",
      });
      createReadStream(resolveStoragePath(this.config.RECEIPT_STORAGE_PATH, receipt.storageKey))
        .on("error", () => response.destroy())
        .pipe(response);
      return;
    }

    if (method === "GET" && path === "/api/v1/orders") {
      const orders = await this.prisma.order.findMany({
        where: { userId: auth.user.id },
        include: { recipientCard: true, provisioning: true },
        orderBy: { createdAt: "desc" },
      });
      sendJson(
        response,
        200,
        orders.map((order) =>
          serializeOrder(
            order,
            order.recipientCard.panLastFour ? `******${order.recipientCard.panLastFour}` : "",
          ),
        ),
      );
      return;
    }
    if (method === "GET" && path === "/api/v1/subscriptions") {
      const subscriptions = await this.prisma.subscription.findMany({
        where: { userId: auth.user.id },
        orderBy: { createdAt: "desc" },
      });
      sendJson(
        response,
        200,
        subscriptions.map((subscription) => ({
          id: subscription.id,
          status: subscription.status,
          expiresAt: subscription.expiresAt.toISOString(),
          trafficBytes: subscription.trafficBytes.toString(),
          trafficUsedBytes: subscription.trafficUsedBytes.toString(),
          provisionedAt: subscription.provisionedAt?.toISOString() ?? null,
          deliveredAt: subscription.deliveredAt?.toISOString() ?? null,
          configsAvailable: Boolean(subscription.linksEncrypted),
        })),
      );
      return;
    }

    const subscriptionConfigsMatch = /^\/api\/v1\/subscriptions\/([^/]+)\/configs$/u.exec(path);
    if (method === "GET" && subscriptionConfigsMatch) {
      const subscriptionId = subscriptionConfigsMatch[1];
      if (!subscriptionId) throw new ApiError(404, "not_found", "Route not found");
      const subscription = await this.ownedSubscription(auth.user.id, subscriptionId);
      const links = this.decryptSubscriptionLinks(subscription);
      await this.auditSensitiveAccess(
        auth.user.id,
        "subscription.configs.viewed",
        subscription.id,
        context.correlationId,
        { count: links.length },
      );
      sendJson(response, 200, {
        subscriptionId: subscription.id,
        links,
        expiresAt: subscription.expiresAt.toISOString(),
      });
      return;
    }

    const subscriptionQrMatch = /^\/api\/v1\/subscriptions\/([^/]+)\/configs\/(\d+)\/qr$/u.exec(
      path,
    );
    if (method === "GET" && subscriptionQrMatch) {
      const subscriptionId = subscriptionQrMatch[1];
      const indexText = subscriptionQrMatch[2];
      if (!subscriptionId || !indexText) throw new ApiError(404, "not_found", "Route not found");
      const subscription = await this.ownedSubscription(auth.user.id, subscriptionId);
      const links = this.decryptSubscriptionLinks(subscription);
      const index = Number.parseInt(indexText, 10);
      const link = links[index];
      if (!link)
        throw new ApiError(404, "config_not_found", "Connection configuration was not found");
      const png = await QRCode.toBuffer(link, {
        type: "png",
        width: 640,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      await this.auditSensitiveAccess(
        auth.user.id,
        "subscription.qr.viewed",
        subscription.id,
        context.correlationId,
        { index },
      );
      response.writeHead(200, {
        "content-type": "image/png",
        "content-disposition": `inline; filename="hollowcon-${subscription.id}-${index + 1}.png"`,
        "cache-control": "no-store, private",
        "content-length": png.byteLength,
      });
      response.end(png);
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/reviews") {
      requireRole(auth.user, ["owner", "admin", "finance"]);
      const reviews = await this.prisma.order.findMany({
        where: { status: "under_review" },
        include: {
          user: true,
          plan: true,
          recipientCard: true,
          receipts: { where: { current: true }, take: 1 },
        },
        orderBy: { createdAt: "asc" },
      });
      sendJson(
        response,
        200,
        reviews.map((order) => {
          const receipt = order.receipts[0];
          return {
            id: order.id,
            user: { telegramId: order.user.telegramId.toString(), firstName: order.user.firstName },
            planNameFa: order.planNameFa,
            planNameEn: order.planNameEn,
            payableAmountRial: order.payableAmountRial.toString(),
            receipt: receipt
              ? {
                  id: receipt.id,
                  revision: receipt.revision,
                  duplicateCount: receipt.duplicateCount,
                  mediaType: receipt.detectedMediaType,
                  submittedAt: receipt.submittedAt.toISOString(),
                  downloadUrl: `/api/v1/receipts/${receipt.id}`,
                }
              : null,
          };
        }),
      );
      return;
    }

    const reviewMatch = /^\/api\/v1\/admin\/orders\/([^/]+)\/review$/u.exec(path);
    if (method === "POST" && reviewMatch) {
      requireRole(auth.user, ["owner", "admin", "finance"]);
      const orderId = reviewMatch[1];
      if (!orderId) throw new ApiError(404, "not_found", "Route not found");
      const input = paymentReviewRequestSchema.parse(await readJson(request));
      const result = await this.commerce.reviewPayment({
        orderId,
        reviewerId: auth.user.id,
        approved: input.approved,
        reason: input.reason,
        correlationId: context.correlationId,
      });
      sendJson(response, 200, {
        orderId: result.order.id,
        status: result.order.status,
        alreadyFinalized: result.alreadyFinalized,
      });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/cards") {
      requireRole(auth.user, ["owner", "admin", "finance"]);
      const cards = await this.prisma.recipientCard.findMany({ orderBy: { createdAt: "desc" } });
      sendJson(
        response,
        200,
        cards.map((card) => ({
          id: card.id,
          panMasked: `******${card.panLastFour}`,
          cardholderName: card.cardholderName,
          pendingLimit: card.pendingLimit,
          active: card.active,
          createdAt: card.createdAt.toISOString(),
        })),
      );
      return;
    }

    const cardMatch = /^\/api\/v1\/admin\/cards\/([^/]+)$/u.exec(path);
    if (method === "PATCH" && cardMatch) {
      requireRole(auth.user, ["owner", "admin", "finance"]);
      const cardId = cardMatch[1];
      if (!cardId) throw new ApiError(404, "not_found", "Route not found");
      const input = updateCardSchema.parse(await readJson(request));
      const current = await this.prisma.recipientCard.findUnique({ where: { id: cardId } });
      if (!current) throw new ApiError(404, "card_not_found", "Recipient card not found");
      if (current.active && input.active === false) {
        const activeCards = await this.prisma.recipientCard.count({ where: { active: true } });
        if (activeCards <= 1)
          throw new ApiError(
            409,
            "last_active_card",
            "The last active recipient card cannot be disabled",
          );
      }
      const encrypted = input.pan
        ? encryptSecret({
            plaintext: input.pan,
            masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
            purpose: "recipient-pan",
            context: "recipient-card",
          })
        : null;
      const updated = await this.prisma.$transaction(async (transaction) => {
        const card = await transaction.recipientCard.update({
          where: { id: current.id },
          data: {
            ...(encrypted
              ? {
                  panEncrypted: encrypted.ciphertext,
                  panKeyId: encrypted.keyId,
                  panLastFour: panLastFour(input.pan ?? ""),
                }
              : {}),
            ...(input.cardholderName !== undefined ? { cardholderName: input.cardholderName } : {}),
            ...(input.pendingLimit !== undefined ? { pendingLimit: input.pendingLimit } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "recipient_card.updated",
            subjectType: "recipient_card",
            subjectId: card.id,
            correlationId: context.correlationId,
            metadata: {
              panRotated: Boolean(input.pan),
              active: card.active,
              pendingLimit: card.pendingLimit,
            },
          },
        });
        return card;
      });
      sendJson(response, 200, {
        id: updated.id,
        panMasked: `******${updated.panLastFour}`,
        cardholderName: updated.cardholderName,
        pendingLimit: updated.pendingLimit,
        active: updated.active,
      });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/plans") {
      requireRole(auth.user, [
        "owner",
        "admin",
        "finance",
        "support",
        "server_operator",
        "marketing",
        "auditor",
      ]);
      const plans = await this.prisma.plan.findMany({
        include: { eligibleInbounds: true },
        orderBy: { createdAt: "desc" },
      });
      sendJson(
        response,
        200,
        plans.map((plan) => ({
          ...serializePlan(plan),
          active: plan.active,
          inboundIds: plan.eligibleInbounds.map((entry) => entry.panelInboundId),
        })),
      );
      return;
    }

    const planMatch = /^\/api\/v1\/admin\/plans\/([^/]+)$/u.exec(path);
    if (method === "PATCH" && planMatch) {
      requireRole(auth.user, ["owner", "admin"]);
      const planId = planMatch[1];
      if (!planId) throw new ApiError(404, "not_found", "Route not found");
      const input = updatePlanSchema.parse(await readJson(request));
      const current = await this.prisma.plan.findUnique({ where: { id: planId } });
      if (!current) throw new ApiError(404, "plan_not_found", "Plan not found");
      const protocol = input.protocol ?? current.protocol;
      let inbounds: Array<{ id: string; protocol: string }> | undefined;
      if (input.inboundIds) {
        inbounds = await this.prisma.panelInbound.findMany({
          where: { id: { in: input.inboundIds } },
          select: { id: true, protocol: true },
        });
        if (
          inbounds.length !== input.inboundIds.length ||
          inbounds.some((inbound) => inbound.protocol !== protocol)
        ) {
          throw new ApiError(
            400,
            "invalid_inbounds",
            "Selected inbounds must match the plan protocol",
          );
        }
      }
      const updated = await this.prisma.$transaction(async (transaction) => {
        const plan = await transaction.plan.update({
          where: { id: current.id },
          data: {
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.nameFa !== undefined ? { nameFa: input.nameFa } : {}),
            ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
            ...(input.priceRial !== undefined ? { priceRial: BigInt(input.priceRial) } : {}),
            ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
            ...(input.trafficBytes !== undefined
              ? { trafficBytes: BigInt(input.trafficBytes) }
              : {}),
            ...(input.deviceLimit !== undefined ? { deviceLimit: input.deviceLimit } : {}),
            ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        });
        if (inbounds) {
          await transaction.planInbound.deleteMany({ where: { planId: current.id } });
          if (inbounds.length > 0)
            await transaction.planInbound.createMany({
              data: inbounds.map((inbound) => ({ planId: current.id, panelInboundId: inbound.id })),
            });
        }
        await transaction.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "plan.updated",
            subjectType: "plan",
            subjectId: plan.id,
            correlationId: context.correlationId,
            metadata: {
              active: plan.active,
              protocol: plan.protocol,
              eligibilityUpdated: Boolean(inbounds),
            },
          },
        });
        return plan;
      });
      sendJson(response, 200, {
        ...serializePlan(updated),
        active: updated.active,
        ...(inbounds ? { inboundIds: inbounds.map((inbound) => inbound.id) } : {}),
      });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/panels") {
      requireRole(auth.user, ["owner", "admin", "server_operator", "auditor"]);
      const panels = await this.prisma.panel.findMany({
        include: { inbounds: true },
        orderBy: { createdAt: "desc" },
      });
      sendJson(
        response,
        200,
        panels.map((panel) => ({
          id: panel.id,
          name: panel.name,
          baseUrl: panel.baseUrl,
          expectedVersion: panel.expectedVersion,
          enabled: panel.enabled,
          weight: panel.weight,
          lastHealthyAt: panel.lastHealthyAt?.toISOString() ?? null,
          lastErrorCode: panel.lastErrorCode,
          inbounds: panel.inbounds.map((inbound) => ({
            id: inbound.id,
            remoteId: inbound.remoteId,
            tag: inbound.tag,
            remark: inbound.remark,
            protocol: inbound.protocol,
            port: inbound.port,
            enabled: inbound.enabled,
            capacity: inbound.capacity,
            activeClients: inbound.activeClients,
          })),
        })),
      );
      return;
    }

    const panelMatch = /^\/api\/v1\/admin\/panels\/([^/]+)$/u.exec(path);
    if (method === "PATCH" && panelMatch) {
      requireRole(auth.user, ["owner", "admin", "server_operator"]);
      const panelId = panelMatch[1];
      if (!panelId) throw new ApiError(404, "not_found", "Route not found");
      const input = updatePanelSchema.parse(await readJson(request));
      const current = await this.prisma.panel.findUnique({ where: { id: panelId } });
      if (!current) throw new ApiError(404, "panel_not_found", "Panel not found");
      const token = input.apiToken
        ? input.apiToken
        : decryptSecret({
            ciphertext: current.apiTokenEncrypted,
            masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
            purpose: "panel-token",
            context: current.baseUrl,
            expectedKeyId: current.apiTokenKeyId,
          });
      const tested =
        input.apiToken || input.synchronize ? await this.probePanel(current.baseUrl, token) : null;
      if (tested?.version && tested.version !== current.expectedVersion)
        throw new ApiError(
          409,
          "panel_version_mismatch",
          "The panel version does not match the configured version",
        );
      const encrypted = input.apiToken
        ? encryptSecret({
            plaintext: input.apiToken,
            masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
            purpose: "panel-token",
            context: current.baseUrl,
          })
        : null;
      const updated = await this.prisma.$transaction(async (transaction) => {
        const panel = await transaction.panel.update({
          where: { id: current.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            ...(encrypted
              ? { apiTokenEncrypted: encrypted.ciphertext, apiTokenKeyId: encrypted.keyId }
              : {}),
            ...(tested
              ? {
                  lastHealthyAt: new Date(),
                  consecutiveFailures: 0,
                  circuitOpenUntil: null,
                  lastErrorCode: null,
                }
              : {}),
          },
        });
        if (tested) {
          for (const inbound of tested.inbounds) {
            await transaction.panelInbound.upsert({
              where: { panelId_remoteId: { panelId: current.id, remoteId: inbound.id } },
              create: {
                panelId: current.id,
                remoteId: inbound.id,
                tag: inbound.tag,
                remark: inbound.remark,
                protocol: inbound.protocol,
                port: inbound.port,
                enabled: false,
                lastSyncedAt: new Date(),
              },
              update: {
                tag: inbound.tag,
                remark: inbound.remark,
                protocol: inbound.protocol,
                port: inbound.port,
                lastSyncedAt: new Date(),
              },
            });
          }
        }
        await transaction.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "panel.updated",
            subjectType: "panel",
            subjectId: panel.id,
            correlationId: context.correlationId,
            metadata: {
              tokenRotated: Boolean(input.apiToken),
              synchronized: Boolean(tested),
              enabled: panel.enabled,
              weight: panel.weight,
            },
          },
        });
        return panel;
      });
      sendJson(response, 200, {
        id: updated.id,
        name: updated.name,
        enabled: updated.enabled,
        weight: updated.weight,
        synchronized: Boolean(tested),
      });
      return;
    }

    const inboundMatch = /^\/api\/v1\/admin\/inbounds\/([^/]+)$/u.exec(path);
    if (method === "PATCH" && inboundMatch) {
      requireRole(auth.user, ["owner", "admin", "server_operator"]);
      const inboundId = inboundMatch[1];
      if (!inboundId) throw new ApiError(404, "not_found", "Route not found");
      const input = updateInboundSchema.parse(await readJson(request));
      const current = await this.prisma.panelInbound.findUnique({ where: { id: inboundId } });
      if (!current) throw new ApiError(404, "inbound_not_found", "Inbound not found");
      if (
        input.capacity !== undefined &&
        input.capacity !== null &&
        input.capacity < current.activeClients
      )
        throw new ApiError(
          409,
          "capacity_below_usage",
          "Inbound capacity cannot be lower than its active client count",
        );
      const updated = await this.prisma.$transaction(async (transaction) => {
        const inbound = await transaction.panelInbound.update({
          where: { id: current.id },
          data: {
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "inbound.updated",
            subjectType: "panel_inbound",
            subjectId: inbound.id,
            correlationId: context.correlationId,
            metadata: { enabled: inbound.enabled, capacity: inbound.capacity },
          },
        });
        return inbound;
      });
      sendJson(response, 200, {
        id: updated.id,
        enabled: updated.enabled,
        capacity: updated.capacity,
        activeClients: updated.activeClients,
      });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/operators") {
      requireRole(auth.user, ["owner", "admin", "auditor"]);
      const users = await this.prisma.user.findMany({
        where: { OR: [{ role: { not: null } }, { disabledAt: { not: null } }] },
        orderBy: { createdAt: "asc" },
      });
      sendJson(
        response,
        200,
        users.map((user) => ({
          id: user.id,
          telegramId: user.telegramId.toString(),
          username: user.username,
          firstName: user.firstName,
          role: user.role,
          disabledAt: user.disabledAt?.toISOString() ?? null,
          roleAssignedAt: user.roleAssignedAt?.toISOString() ?? null,
        })),
      );
      return;
    }

    const operatorMatch = /^\/api\/v1\/admin\/operators\/([^/]+)$/u.exec(path);
    if (method === "PATCH" && operatorMatch) {
      requireRole(auth.user, ["owner"]);
      const userId = operatorMatch[1];
      if (!userId) throw new ApiError(404, "not_found", "Route not found");
      const input = z
        .object({
          role: z
            .enum([
              "owner",
              "admin",
              "finance",
              "support",
              "server_operator",
              "marketing",
              "auditor",
            ])
            .nullable(),
          disabled: z.boolean().default(false),
          confirmation: z.literal("UPDATE OPERATOR"),
        })
        .parse(await readJson(request));
      const target = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!target) throw new ApiError(404, "user_not_found", "User not found");
      if (target.role === "owner" && (input.role !== "owner" || input.disabled)) {
        const owners = await this.prisma.user.count({ where: { role: "owner", disabledAt: null } });
        if (owners <= 1)
          throw new ApiError(
            409,
            "last_owner",
            "The last active owner cannot be removed or disabled",
          );
      }
      const updated = await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.update({
          where: { id: target.id },
          data: {
            role: input.role,
            roleAssignedAt: input.role ? new Date() : null,
            roleRevokedAt: input.role ? null : new Date(),
            disabledAt: input.disabled ? new Date() : null,
          },
        });
        await transaction.adminSession.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "operator.updated",
            subjectType: "user",
            subjectId: target.id,
            correlationId: context.correlationId,
            metadata: { previousRole: target.role, role: input.role, disabled: input.disabled },
          },
        });
        return user;
      });
      sendJson(response, 200, {
        id: updated.id,
        role: updated.role,
        disabledAt: updated.disabledAt?.toISOString() ?? null,
      });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/settings") {
      requireRole(auth.user, ["owner", "admin", "auditor"]);
      const settings = await this.prisma.systemSettings.findUnique({ where: { id: 1 } });
      sendJson(response, 200, {
        ...settings,
        environment: {
          customerOrdersEnabled: this.config.CUSTOMER_ORDERS_ENABLED,
          panelMutationsEnabled: this.config.PANEL_MUTATIONS_ENABLED,
        },
      });
      return;
    }

    if (method === "PATCH" && path === "/api/v1/admin/settings") {
      requireRole(auth.user, ["owner"]);
      const input = z
        .object({
          customerOrderMode: z.enum(["disabled", "owner_test", "enabled"]),
          panelMutationsEnabled: z.boolean(),
          supportContact: z.string().trim().min(3).max(160),
          termsVersion: z.string().min(1).max(32),
          confirmation: z.literal("APPLY SAFETY SETTINGS"),
        })
        .parse(await readJson(request));
      if (input.customerOrderMode !== "disabled" && !this.config.CUSTOMER_ORDERS_ENABLED)
        throw new ApiError(
          409,
          "environment_gate_disabled",
          "Customer ordering is disabled by the deployment environment",
        );
      if (input.panelMutationsEnabled && !this.config.PANEL_MUTATIONS_ENABLED)
        throw new ApiError(
          409,
          "environment_gate_disabled",
          "Panel mutations are disabled by the deployment environment",
        );
      await this.validateOperationalReadiness(input.customerOrderMode !== "disabled");
      const settings = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.systemSettings.update({
          where: { id: 1 },
          data: {
            customerOrderMode: input.customerOrderMode,
            customerOrdersEnabled: input.customerOrderMode === "enabled",
            panelMutationsEnabled: input.panelMutationsEnabled,
            supportContact: input.supportContact,
            termsVersion: input.termsVersion,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "settings.safety.updated",
            subjectType: "system",
            subjectId: "1",
            correlationId: context.correlationId,
            metadata: {
              customerOrderMode: input.customerOrderMode,
              panelMutationsEnabled: input.panelMutationsEnabled,
            },
          },
        });
        return updated;
      });
      sendJson(response, 200, {
        customerOrderMode: settings.customerOrderMode,
        panelMutationsEnabled: settings.panelMutationsEnabled,
        supportContact: settings.supportContact,
        termsVersion: settings.termsVersion,
      });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/provisioning") {
      requireRole(auth.user, ["owner", "admin", "server_operator", "auditor"]);
      const jobs = await this.prisma.provisioningJob.findMany({
        include: {
          order: {
            select: {
              id: true,
              planNameFa: true,
              planNameEn: true,
              user: { select: { telegramId: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      sendJson(
        response,
        200,
        jobs.map((job) => ({
          id: job.id,
          orderId: job.orderId,
          status: job.status,
          attempts: job.attempts,
          nextAttemptAt: job.nextAttemptAt.toISOString(),
          lastErrorCode: job.lastErrorCode,
          lastErrorSafe: job.lastErrorSafe,
          planNameFa: job.order.planNameFa,
          planNameEn: job.order.planNameEn,
          telegramId: job.order.user.telegramId.toString(),
        })),
      );
      return;
    }

    const retryJobMatch = /^\/api\/v1\/admin\/provisioning\/([^/]+)\/retry$/u.exec(path);
    if (method === "POST" && retryJobMatch) {
      requireRole(auth.user, ["owner", "admin", "server_operator"]);
      const jobId = retryJobMatch[1];
      if (!jobId) throw new ApiError(404, "not_found", "Route not found");
      const input = z
        .object({ reason: z.string().trim().min(3).max(1000) })
        .parse(await readJson(request));
      const job = await this.prisma.provisioningJob.findUnique({ where: { id: jobId } });
      if (!job) throw new ApiError(404, "job_not_found", "Provisioning job not found");
      await this.prisma.$transaction([
        this.prisma.provisioningJob.update({
          where: { id: job.id },
          data: {
            status: "queued",
            nextAttemptAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        }),
        this.prisma.outboxEvent.upsert({
          where: { idempotencyKey: job.idempotencyKey },
          create: {
            aggregateType: "order",
            aggregateId: job.orderId,
            eventType: "order.provisioning.requested",
            idempotencyKey: job.idempotencyKey,
            payload: { orderId: job.orderId, provisioningJobId: job.id },
          },
          update: {
            processedAt: null,
            availableAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorSafe: null,
          },
        }),
        this.prisma.auditEvent.create({
          data: {
            actorId: auth.user.id,
            action: "provisioning.requeued",
            subjectType: "provisioning_job",
            subjectId: job.id,
            reason: input.reason,
            correlationId: context.correlationId,
            metadata: { orderId: job.orderId },
          },
        }),
      ]);
      sendJson(response, 200, { id: job.id, status: "queued" });
      return;
    }

    if (method === "GET" && path === "/api/v1/admin/audit") {
      requireRole(auth.user, ["owner", "admin", "finance", "server_operator", "auditor"]);
      const events = await this.prisma.auditEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { actor: { select: { telegramId: true, username: true } } },
      });
      sendJson(
        response,
        200,
        events.map((event) => ({
          id: event.id,
          action: event.action,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          reason: event.reason,
          correlationId: event.correlationId,
          metadata: event.metadata,
          createdAt: event.createdAt.toISOString(),
          actor: event.actor
            ? { telegramId: event.actor.telegramId.toString(), username: event.actor.username }
            : null,
        })),
      );
      return;
    }

    if (method === "POST" && path === "/api/v1/admin/setup/card") {
      this.requireSetupOwner(auth.user);
      const input = setupCardSchema.parse(await readJson(request));
      const encrypted = encryptSecret({
        plaintext: input.pan,
        masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
        purpose: "recipient-pan",
        context: "recipient-card",
      });
      const card = await this.prisma.recipientCard.create({
        data: {
          panEncrypted: encrypted.ciphertext,
          panKeyId: encrypted.keyId,
          panLastFour: panLastFour(input.pan),
          cardholderName: input.cardholderName,
          pendingLimit: input.pendingLimit,
        },
      });
      sendJson(response, 201, {
        id: card.id,
        panMasked: maskIranianPan(input.pan),
        cardholderName: card.cardholderName,
      });
      return;
    }

    if (method === "POST" && path === "/api/v1/admin/setup/plan") {
      this.requireSetupOwner(auth.user);
      const input = setupPlanSchema.parse(await readJson(request));
      const plan = await this.prisma.plan.create({
        data: {
          slug: input.slug,
          nameFa: input.nameFa,
          nameEn: input.nameEn,
          priceRial: BigInt(input.priceRial),
          durationDays: input.durationDays,
          trafficBytes: BigInt(input.trafficBytes),
          deviceLimit: input.deviceLimit,
          protocol: input.protocol,
          active: input.active,
        },
      });
      sendJson(response, 201, serializePlan(plan));
      return;
    }

    if (method === "POST" && path === "/api/v1/admin/setup/panel") {
      this.requireSetupOwner(auth.user);
      const input = setupPanelSchema.parse(await readJson(request));
      const encrypted = encryptSecret({
        plaintext: input.apiToken,
        masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
        purpose: "panel-token",
        context: input.baseUrl,
      });
      const tested = await this.probePanel(input.baseUrl, input.apiToken);
      const inbounds = tested.inbounds;
      const panel = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.panel.create({
          data: {
            name: input.name,
            baseUrl: input.baseUrl,
            apiTokenEncrypted: encrypted.ciphertext,
            apiTokenKeyId: encrypted.keyId,
            expectedVersion: input.expectedVersion,
            lastHealthyAt: new Date(),
          },
        });
        await transaction.panelInbound.createMany({
          data: inbounds.map((inbound) => ({
            panelId: created.id,
            remoteId: inbound.id,
            tag: inbound.tag,
            remark: inbound.remark,
            protocol: inbound.protocol,
            port: inbound.port,
            enabled: false,
            lastSyncedAt: new Date(),
          })),
        });
        return created;
      });
      const storedInbounds = await this.prisma.panelInbound.findMany({
        where: { panelId: panel.id },
      });
      sendJson(response, 201, { id: panel.id, name: panel.name, inbounds: storedInbounds });
      return;
    }

    if (method === "POST" && path === "/api/v1/admin/setup/eligibility") {
      this.requireSetupOwner(auth.user);
      const input = setupEligibilitySchema.parse(await readJson(request));
      const plan = await this.prisma.plan.findUnique({ where: { id: input.planId } });
      if (!plan) throw new ApiError(404, "plan_not_found", "Plan not found");
      const inbounds = await this.prisma.panelInbound.findMany({
        where: { id: { in: input.inboundIds } },
      });
      if (
        inbounds.length !== input.inboundIds.length ||
        inbounds.some((inbound) => inbound.protocol !== plan.protocol)
      ) {
        throw new ApiError(
          400,
          "invalid_inbounds",
          "Selected inbounds must match the plan protocol",
        );
      }
      await this.prisma.$transaction([
        this.prisma.panelInbound.updateMany({
          where: { id: { in: inbounds.map((inbound) => inbound.id) } },
          data: { enabled: true },
        }),
        this.prisma.planInbound.createMany({
          data: inbounds.map((inbound) => ({ planId: plan.id, panelInboundId: inbound.id })),
          skipDuplicates: true,
        }),
      ]);
      sendJson(response, 200, {
        planId: plan.id,
        inboundIds: inbounds.map((inbound) => inbound.id),
      });
      return;
    }

    if (method === "POST" && path === "/api/v1/admin/setup/finalize") {
      this.requireSetupOwner(auth.user);
      const input = setupFinalizeSchema.parse(await readJson(request));
      const completed = await this.prisma.$transaction(async (transaction) => {
        const [cardCount, plans, panelCount] = await Promise.all([
          transaction.recipientCard.count({ where: { active: true } }),
          transaction.plan.findMany({
            where: { active: true },
            include: {
              eligibleInbounds: { include: { panelInbound: { include: { panel: true } } } },
            },
          }),
          transaction.panel.count({ where: { enabled: true } }),
        ]);
        if (
          cardCount < 1 ||
          plans.length < 1 ||
          panelCount < 1 ||
          plans.some(
            (plan) =>
              !plan.eligibleInbounds.some(
                (entry) =>
                  entry.panelInbound.enabled &&
                  entry.panelInbound.panel.enabled &&
                  entry.panelInbound.protocol === plan.protocol,
              ),
          )
        ) {
          throw new ApiError(
            409,
            "setup_incomplete",
            "Every active plan requires an enabled compatible inbound, plus an active card and panel",
          );
        }
        return transaction.systemSettings.upsert({
          where: { id: 1 },
          create: {
            id: 1,
            setupCompletedAt: new Date(),
            termsVersion: input.termsVersion,
            supportContact: input.supportContact,
          },
          update: {
            setupCompletedAt: new Date(),
            termsVersion: input.termsVersion,
            supportContact: input.supportContact,
          },
        });
      });
      sendJson(response, 200, {
        setupCompletedAt: completed.setupCompletedAt?.toISOString() ?? null,
      });
      return;
    }

    throw new ApiError(404, "not_found", "Route not found");
  }

  private async requireAuthenticated(
    context: ReturnType<typeof createContext>,
    mutating: boolean,
  ): Promise<Authenticated> {
    const token = parseCookies(context.request).get(SESSION_COOKIE);
    const auth = await authenticateSession(
      this.prisma,
      token,
      this.config.ADMIN_SESSION_SECRET,
      !mutating,
    );
    if (mutating) {
      requireSameOrigin(context.request, this.config.PUBLIC_BASE_URL);
      const csrfHeader = context.request.headers["x-csrf-token"];
      const csrfValue = typeof csrfHeader === "string" ? csrfHeader : undefined;
      const csrfCookieValue = parseCookies(context.request).get(CSRF_COOKIE);
      if (!csrfValue || csrfValue !== csrfCookieValue)
        throw new ApiError(403, "csrf_failed", "CSRF validation failed");
      verifyCsrfToken(csrfValue, auth.csrfHash, this.config.ADMIN_SESSION_SECRET);
    }
    return auth;
  }

  private requireSetupOwner(user: Authenticated["user"]): void {
    requireRole(user, ["owner"]);
  }

  private async requireOrdersEnabled(user: Authenticated["user"]): Promise<void> {
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 1 } });
    const mode =
      settings?.customerOrderMode ?? (settings?.customerOrdersEnabled ? "enabled" : "disabled");
    const ownerTestAllowed = mode === "owner_test" && user.role === "owner";
    if (
      !settings?.setupCompletedAt ||
      !this.config.CUSTOMER_ORDERS_ENABLED ||
      (mode !== "enabled" && !ownerTestAllowed)
    ) {
      throw new ApiError(503, "orders_disabled", "Ordering is temporarily unavailable");
    }
  }

  private async validateOperationalReadiness(enablingOrders: boolean): Promise<void> {
    const [cardCount, panels, plans] = await Promise.all([
      this.prisma.recipientCard.count({ where: { active: true } }),
      this.prisma.panel.findMany({ where: { enabled: true }, include: { inbounds: true } }),
      this.prisma.plan.findMany({
        where: { active: true },
        include: { eligibleInbounds: { include: { panelInbound: { include: { panel: true } } } } },
      }),
    ]);
    if (cardCount < 1 || panels.length < 1)
      throw new ApiError(409, "system_not_ready", "An active card and panel are required");
    if (
      enablingOrders &&
      (plans.length < 1 ||
        plans.some(
          (plan) =>
            !plan.eligibleInbounds.some(
              (entry) =>
                entry.panelInbound.enabled &&
                entry.panelInbound.panel.enabled &&
                entry.panelInbound.protocol === plan.protocol,
            ),
        ))
    ) {
      throw new ApiError(
        409,
        "system_not_ready",
        "Every active plan must have an enabled compatible inbound",
      );
    }
  }

  private async ownedSubscription(userId: string, subscriptionId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, userId },
    });
    if (!subscription?.linksEncrypted)
      throw new ApiError(
        404,
        "subscription_not_found",
        "Subscription configurations are not available",
      );
    return subscription;
  }

  private decryptSubscriptionLinks(
    subscription: Awaited<ReturnType<ApiApplication["ownedSubscription"]>>,
  ): string[] {
    if (!subscription.linksEncrypted)
      throw new ApiError(
        404,
        "subscription_not_found",
        "Subscription configurations are not available",
      );
    const plaintext = decryptSecret({
      ciphertext: subscription.linksEncrypted,
      masterKey: this.config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "subscription-links",
      context: subscription.orderId,
      ...(subscription.linksKeyId ? { expectedKeyId: subscription.linksKeyId } : {}),
    });
    try {
      const parsed = JSON.parse(plaintext) as unknown;
      if (
        !Array.isArray(parsed) ||
        !parsed.every((link) => typeof link === "string" && link.length > 0)
      ) {
        throw new Error("invalid links");
      }
      return parsed as string[];
    } catch {
      throw new ApiError(
        503,
        "subscription_unavailable",
        "Subscription configurations are temporarily unavailable",
      );
    }
  }

  private async auditSensitiveAccess(
    actorId: string,
    action: string,
    subjectId: string,
    correlationId: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: { actorId, action, subjectType: "subscription", subjectId, correlationId, metadata },
    });
  }
}

function serializeMe(user: Authenticated["user"], csrfToken: string): object {
  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    locale: user.locale,
    role: user.role,
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    csrfToken,
  };
}

function serializePlan(plan: {
  id: string;
  slug: string;
  nameFa: string;
  nameEn: string;
  priceRial: bigint;
  durationDays: number;
  trafficBytes: bigint;
  deviceLimit: number;
  protocol: string;
}): object {
  return {
    id: plan.id,
    slug: plan.slug,
    nameFa: plan.nameFa,
    nameEn: plan.nameEn,
    priceRial: plan.priceRial.toString(),
    durationDays: plan.durationDays,
    trafficBytes: plan.trafficBytes.toString(),
    deviceLimit: plan.deviceLimit,
    protocol: plan.protocol,
  };
}

function serializeOrder(
  order: {
    id: string;
    status: string;
    planNameFa: string;
    planNameEn: string;
    payableAmountRial: bigint;
    uniqueSuffixRial: number;
    reservationExpires: Date;
    createdAt: Date;
  },
  recipientCardMasked: string,
): object {
  return {
    id: order.id,
    status: order.status,
    planNameFa: order.planNameFa,
    planNameEn: order.planNameEn,
    payableAmountRial: order.payableAmountRial.toString(),
    uniqueSuffixRial: order.uniqueSuffixRial,
    recipientCardMasked,
    reservationExpires: order.reservationExpires.toISOString(),
    createdAt: order.createdAt.toISOString(),
  };
}

function translateError(error: unknown): Error {
  if (error instanceof ApiError) return error;
  if (error instanceof CommerceNotFoundError)
    return new ApiError(404, "not_found", "Requested record was not found");
  if (error instanceof CommercePermissionError)
    return new ApiError(403, "forbidden", "You are not allowed to perform this action");
  if (error instanceof CommerceConflictError)
    return new ApiError(409, "conflict", "Request conflicts with the current state");
  if (error instanceof CommerceValidationError || error instanceof z.ZodError)
    return new ApiError(400, "validation_failed", "Request validation failed");
  return error instanceof Error ? error : new Error("Unknown error");
}
