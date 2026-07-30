import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { CommerceConflictError, CommerceNotFoundError, CommercePermissionError, CommerceService, CommerceValidationError } from "@hollowcon/commerce";
import {
  createOrderRequestSchema,
  paymentReviewRequestSchema,
  setupCardSchema,
  setupEligibilitySchema,
  setupFinalizeSchema,
  setupPanelSchema,
  setupPlanSchema,
  telegramAuthRequestSchema,
} from "@hollowcon/contracts";
import { loadConfig } from "@hollowcon/config";
import { decryptSecret, encryptSecret, generateOpaqueToken, hashOpaqueToken, maskIranianPan, panLastFour } from "@hollowcon/security";
import { verifyTelegramInitData } from "@hollowcon/telegram";
import { ThreeXUiClient } from "@hollowcon/three-x-ui";
import { z } from "zod";

import { ApiError, createContext, parseCookies, readJson, requireSameOrigin, sendApiError, sendJson } from "./lib/http.js";
import { removeStoredReceipt, resolveStoragePath, storeReceipt } from "./lib/receipts.js";
import {
  authenticateSession,
  clearSessionCookie,
  createSession,
  requireRole,
  sessionCookie,
  SESSION_COOKIE,
  verifyCsrfToken,
} from "./lib/sessions.js";

const config = loadConfig();
const port = Number.parseInt(process.env["API_PORT"] ?? "3000", 10);
const prisma = new PrismaClient();
const commerce = new CommerceService(prisma);
let ready = false;

type Authenticated = Awaited<ReturnType<typeof authenticateSession>>;

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const context = createContext(request, response);
  try {
    const url = new URL(request.url ?? "/", config.PUBLIC_BASE_URL);
    if (request.method === "GET" && url.pathname === "/health/live") {
      sendJson(response, 200, { status: "ok", service: "api" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      await prisma.$queryRaw`SELECT 1`;
      ready = true;
      sendJson(response, 200, { status: "ready", service: "api" });
      return;
    }
    await route(context, url);
  } catch (error) {
    ready = false;
    sendApiError(context, translateError(error));
  }
}

async function route(context: ReturnType<typeof createContext>, url: URL): Promise<void> {
  const { request, response } = context;
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && path === "/api/v1/installation") {
    const settings = await prisma.systemSettings.findUnique({ where: { id: 1 } });
    sendJson(response, 200, { setupRequired: !settings?.setupCompletedAt });
    return;
  }

  if (method === "POST" && path === "/api/v1/auth/telegram") {
    requireSameOrigin(request, config.PUBLIC_BASE_URL);
    const input = telegramAuthRequestSchema.parse(await readJson(request));
    const verified = verifyTelegramInitData(input.initData, config.TELEGRAM_BOT_TOKEN, new Date(), config.TELEGRAM_AUTH_MAX_AGE_SECONDS);
    if (!verified.user) throw new ApiError(400, "telegram_user_missing", "Telegram user data is required");
    const settings = await prisma.systemSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const initialOwner = BigInt(config.INITIAL_OWNER_TELEGRAM_ID);
    if (!settings.setupCompletedAt && BigInt(verified.user.id) !== initialOwner) {
      throw new ApiError(403, "owner_bootstrap_required", "Only the configured initial owner may complete setup");
    }

    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(verified.user.id) },
      create: {
        telegramId: BigInt(verified.user.id),
        firstName: verified.user.firstName,
        ...(verified.user.username ? { username: verified.user.username } : {}),
        locale: verified.user.languageCode?.startsWith("fa") ? "fa" : settings.defaultLocale,
        ...(BigInt(verified.user.id) === initialOwner ? { role: "owner" } : {}),
      },
      update: {
        firstName: verified.user.firstName,
        username: verified.user.username ?? null,
      },
    });
    const session = await createSession(prisma, user.id, config.ADMIN_SESSION_SECRET, config.SESSION_TTL_SECONDS);
    response.setHeader("set-cookie", sessionCookie(session.token, session.expiresAt));
    sendJson(response, 200, serializeMe(user, session.csrfToken));
    return;
  }

  const auth = await requireAuthenticated(context, method !== "GET");

  if (method === "GET" && path === "/api/v1/me") {
    const csrfToken = await rotateCsrf(auth);
    sendJson(response, 200, serializeMe(auth.user, csrfToken));
    return;
  }
  if (method === "POST" && path === "/api/v1/auth/logout") {
    await prisma.adminSession.update({ where: { id: auth.id }, data: { revokedAt: new Date() } });
    response.setHeader("set-cookie", clearSessionCookie());
    sendJson(response, 200, { status: "signed_out" });
    return;
  }

  if (method === "GET" && path === "/api/v1/plans") {
    const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { priceRial: "asc" } });
    sendJson(response, 200, plans.map(serializePlan));
    return;
  }
  if (method === "POST" && path === "/api/v1/orders") {
    await requireOrdersEnabled();
    const input = createOrderRequestSchema.parse(await readJson(request));
    const card = await prisma.recipientCard.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } });
    if (!card) throw new ApiError(409, "recipient_card_unavailable", "No payment card is currently available");
    const order = await commerce.createOrder({
      userId: auth.user.id,
      planId: input.planId,
      recipientCardId: card.id,
      idempotencyKey: input.idempotencyKey,
      reservationMinutes: config.PAYMENT_RESERVATION_MINUTES,
      uniqueSuffixMin: config.PAYMENT_UNIQUE_SUFFIX_MIN,
      uniqueSuffixMax: config.PAYMENT_UNIQUE_SUFFIX_MAX,
    });
    sendJson(response, 201, serializeOrder(order, maskIranianPan(decryptSecret({
      ciphertext: card.panEncrypted,
      masterKey: config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "recipient-pan",
      context: "recipient-card",
      expectedKeyId: card.panKeyId,
    }))));
    return;
  }

  const orderReceiptMatch = /^\/api\/v1\/orders\/([^/]+)\/receipt$/u.exec(path);
  if (method === "POST" && orderReceiptMatch) {
    const orderId = orderReceiptMatch[1];
    if (!orderId) throw new ApiError(404, "not_found", "Route not found");
    const order = await prisma.order.findFirst({ where: { id: orderId, userId: auth.user.id } });
    if (!order) throw new ApiError(404, "order_not_found", "Order not found");
    const stored = await storeReceipt(request, config.RECEIPT_STORAGE_PATH, config.RECEIPT_MAX_BYTES);
    try {
      const receipt = await commerce.submitReceipt({
        orderId: order.id,
        storageKey: stored.storageKey,
        mediaType: stored.detectedMediaType,
        detectedMediaType: stored.detectedMediaType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        ...(stored.originalFileName ? { originalFileName: stored.originalFileName } : {}),
      });
      sendJson(response, 201, { id: receipt.id, status: "under_review", submittedAt: receipt.submittedAt.toISOString() });
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
    const receipt = await prisma.paymentReceipt.findUnique({
      where: { id: receiptId },
      include: { order: true },
    });
    if (!receipt || (receipt.order.userId !== auth.user.id && !auth.user.role)) {
      throw new ApiError(404, "receipt_not_found", "Receipt not found");
    }
    if (auth.user.role) requireRole(auth.user, ["owner", "admin", "finance"]);
    await prisma.auditEvent.create({
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
    createReadStream(resolveStoragePath(config.RECEIPT_STORAGE_PATH, receipt.storageKey)).on("error", () => response.destroy()).pipe(response);
    return;
  }

  if (method === "GET" && path === "/api/v1/orders") {
    const orders = await prisma.order.findMany({
      where: { userId: auth.user.id },
      include: { recipientCard: true, receipt: true, provisioning: true },
      orderBy: { createdAt: "desc" },
    });
    sendJson(response, 200, orders.map((order) => serializeOrder(order, order.recipientCard.panLastFour ? `******${order.recipientCard.panLastFour}` : "")));
    return;
  }
  if (method === "GET" && path === "/api/v1/subscriptions") {
    const subscriptions = await prisma.subscription.findMany({ where: { userId: auth.user.id }, orderBy: { createdAt: "desc" } });
    sendJson(response, 200, subscriptions.map((subscription) => ({
      id: subscription.id,
      status: subscription.status,
      expiresAt: subscription.expiresAt.toISOString(),
      trafficBytes: subscription.trafficBytes.toString(),
      trafficUsedBytes: subscription.trafficUsedBytes.toString(),
      deliveredAt: subscription.deliveredAt?.toISOString() ?? null,
    })));
    return;
  }

  if (method === "GET" && path === "/api/v1/admin/reviews") {
    requireRole(auth.user, ["owner", "admin", "finance"]);
    const reviews = await prisma.order.findMany({
      where: { status: "under_review" },
      include: { user: true, receipt: true, plan: true, recipientCard: true },
      orderBy: { createdAt: "asc" },
    });
    sendJson(response, 200, reviews.map((order) => ({
      id: order.id,
      user: { telegramId: order.user.telegramId.toString(), firstName: order.user.firstName },
      planNameFa: order.planNameFa,
      planNameEn: order.planNameEn,
      payableAmountRial: order.payableAmountRial.toString(),
      receipt: order.receipt ? {
        id: order.receipt.id,
        duplicateCount: order.receipt.duplicateCount,
        mediaType: order.receipt.detectedMediaType,
        submittedAt: order.receipt.submittedAt.toISOString(),
        downloadUrl: `/api/v1/receipts/${order.receipt.id}`,
      } : null,
    })));
    return;
  }

  const reviewMatch = /^\/api\/v1\/admin\/orders\/([^/]+)\/review$/u.exec(path);
  if (method === "POST" && reviewMatch) {
    requireRole(auth.user, ["owner", "admin", "finance"]);
    const orderId = reviewMatch[1];
    if (!orderId) throw new ApiError(404, "not_found", "Route not found");
    const input = paymentReviewRequestSchema.parse(await readJson(request));
    const result = await commerce.reviewPayment({
      orderId,
      reviewerId: auth.user.id,
      approved: input.approved,
      reason: input.reason,
      correlationId: context.correlationId,
    });
    sendJson(response, 200, { orderId: result.order.id, status: result.order.status, alreadyFinalized: result.alreadyFinalized });
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/setup/card") {
    requireSetupOwner(auth.user);
    const input = setupCardSchema.parse(await readJson(request));
    const encrypted = encryptSecret({
      plaintext: input.pan,
      masterKey: config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "recipient-pan",
      context: "recipient-card",
    });
    const card = await prisma.recipientCard.create({
      data: {
        panEncrypted: encrypted.ciphertext,
        panKeyId: encrypted.keyId,
        panLastFour: panLastFour(input.pan),
        cardholderName: input.cardholderName,
        pendingLimit: input.pendingLimit,
      },
    });
    sendJson(response, 201, { id: card.id, panMasked: maskIranianPan(input.pan), cardholderName: card.cardholderName });
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/setup/plan") {
    requireSetupOwner(auth.user);
    const input = setupPlanSchema.parse(await readJson(request));
    const plan = await prisma.plan.create({
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
    requireSetupOwner(auth.user);
    const input = setupPanelSchema.parse(await readJson(request));
    const encrypted = encryptSecret({
      plaintext: input.apiToken,
      masterKey: config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "panel-token",
      context: input.baseUrl,
    });
    const client = new ThreeXUiClient({ baseUrl: input.baseUrl, apiToken: input.apiToken });
    const tested = await client.testConnection();
    const inbounds = tested.inbounds;
    const panel = await prisma.$transaction(async (transaction) => {
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
    const storedInbounds = await prisma.panelInbound.findMany({ where: { panelId: panel.id } });
    sendJson(response, 201, { id: panel.id, name: panel.name, inbounds: storedInbounds });
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/setup/eligibility") {
    requireSetupOwner(auth.user);
    const input = setupEligibilitySchema.parse(await readJson(request));
    const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan) throw new ApiError(404, "plan_not_found", "Plan not found");
    const inbounds = await prisma.panelInbound.findMany({ where: { id: { in: input.inboundIds } } });
    if (inbounds.length !== input.inboundIds.length || inbounds.some((inbound) => inbound.protocol !== plan.protocol)) {
      throw new ApiError(400, "invalid_inbounds", "Selected inbounds must match the plan protocol");
    }
    await prisma.$transaction([
      prisma.panelInbound.updateMany({ where: { id: { in: inbounds.map((inbound) => inbound.id) } }, data: { enabled: true } }),
      prisma.planInbound.createMany({ data: inbounds.map((inbound) => ({ planId: plan.id, panelInboundId: inbound.id })), skipDuplicates: true }),
    ]);
    sendJson(response, 200, { planId: plan.id, inboundIds: inbounds.map((inbound) => inbound.id) });
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/setup/finalize") {
    requireSetupOwner(auth.user);
    const input = setupFinalizeSchema.parse(await readJson(request));
    const completed = await prisma.$transaction(async (transaction) => {
      const [cardCount, planCount, eligibleCount, panelCount] = await Promise.all([
        transaction.recipientCard.count({ where: { active: true } }),
        transaction.plan.count({ where: { active: true } }),
        transaction.planInbound.count(),
        transaction.panel.count({ where: { enabled: true } }),
      ]);
      if (cardCount < 1 || planCount < 1 || eligibleCount < 1 || panelCount < 1) {
        throw new ApiError(409, "setup_incomplete", "A card, plan, panel, and eligible inbound are required before setup can finish");
      }
      return transaction.systemSettings.upsert({
        where: { id: 1 },
        create: { id: 1, setupCompletedAt: new Date(), termsVersion: input.termsVersion, supportContact: input.supportContact },
        update: { setupCompletedAt: new Date(), termsVersion: input.termsVersion, supportContact: input.supportContact },
      });
    });
    sendJson(response, 200, { setupCompletedAt: completed.setupCompletedAt?.toISOString() ?? null });
    return;
  }

  throw new ApiError(404, "not_found", "Route not found");
}

async function requireAuthenticated(context: ReturnType<typeof createContext>, mutating: boolean): Promise<Authenticated> {
  const token = parseCookies(context.request).get(SESSION_COOKIE);
  const auth = await authenticateSession(prisma, token, config.ADMIN_SESSION_SECRET, !mutating);
  if (mutating) {
    requireSameOrigin(context.request, config.PUBLIC_BASE_URL);
    const csrfHeader = context.request.headers["x-csrf-token"];
    verifyCsrfToken(typeof csrfHeader === "string" ? csrfHeader : undefined, auth.csrfHash, config.ADMIN_SESSION_SECRET);
  }
  return auth;
}

async function rotateCsrf(auth: Authenticated): Promise<string> {
  const csrfToken = generateOpaqueToken();
  await prisma.adminSession.update({
    where: { id: auth.id },
    data: { csrfHash: hashOpaqueToken(csrfToken, config.ADMIN_SESSION_SECRET) },
  });
  return csrfToken;
}

function requireSetupOwner(user: Authenticated["user"]): void {
  requireRole(user, ["owner"]);
}

async function requireOrdersEnabled(): Promise<void> {
  const settings = await prisma.systemSettings.findUnique({ where: { id: 1 } });
  if (!settings?.setupCompletedAt || !settings.customerOrdersEnabled || !config.CUSTOMER_ORDERS_ENABLED) {
    throw new ApiError(503, "orders_disabled", "Ordering is temporarily unavailable");
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

function serializePlan(plan: { id: string; slug: string; nameFa: string; nameEn: string; priceRial: bigint; durationDays: number; trafficBytes: bigint; deviceLimit: number; protocol: string }): object {
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

function serializeOrder(order: { id: string; status: string; planNameFa: string; planNameEn: string; payableAmountRial: bigint; uniqueSuffixRial: number; reservationExpires: Date; createdAt: Date }, recipientCardMasked: string): object {
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
  if (error instanceof CommerceNotFoundError) return new ApiError(404, "not_found", "Requested record was not found");
  if (error instanceof CommercePermissionError) return new ApiError(403, "forbidden", "You are not allowed to perform this action");
  if (error instanceof CommerceConflictError) return new ApiError(409, "conflict", "Request conflicts with the current state");
  if (error instanceof CommerceValidationError || error instanceof z.ZodError) return new ApiError(400, "validation_failed", "Request validation failed");
  return error instanceof Error ? error : new Error("Unknown error");
}

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "api", event: "listening", port }));
});

async function shutdown(signal: string): Promise<void> {
  ready = false;
  console.info(JSON.stringify({ level: "info", service: "api", event: "shutdown", signal }));
  server.close();
  await prisma.$disconnect();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

void ready;
