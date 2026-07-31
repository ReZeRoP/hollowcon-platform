import { type AddressInfo } from "node:net";

import type { AppConfig } from "@hollowcon/config";
import { hashOpaqueToken } from "@hollowcon/security";
import type { User } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { createApiServer, type ApiDependencies } from "./app.js";

const SESSION_SECRET = "integration-session-secret-32-bytes-minimum";
const SESSION_TOKEN = "session-token-with-at-least-thirty-two-characters";
const CSRF_TOKEN = "csrf-token-with-at-least-thirty-two-characters";

const config: AppConfig = {
  NODE_ENV: "test",
  PUBLIC_BASE_URL: "https://hollowcon.test",
  DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
  REDIS_URL: "redis://localhost:6379",
  TELEGRAM_BOT_TOKEN: "123456789:integration-test-telegram-token",
  TELEGRAM_WEBHOOK_SECRET: "integration-webhook-secret-at-least-32-chars",
  TELEGRAM_MINI_APP_URL: "https://hollowcon.test/mini",
  INITIAL_OWNER_TELEGRAM_ID: 1001n,
  PANEL_CREDENTIAL_MASTER_KEY: "integration-panel-master-key-at-least-32-chars",
  ADMIN_SESSION_SECRET: SESSION_SECRET,
  SESSION_TTL_SECONDS: 43_200,
  TELEGRAM_AUTH_MAX_AGE_SECONDS: 300,
  RECEIPT_STORAGE_PATH: "unused",
  RECEIPT_MAX_BYTES: 8_388_608,
  RECEIPT_ALLOWED_MEDIA_TYPES: "image/jpeg,image/png,image/webp,application/pdf",
  PAYMENT_UNIQUE_SUFFIX_MIN: 1,
  PAYMENT_UNIQUE_SUFFIX_MAX: 999,
  PAYMENT_RESERVATION_MINUTES: 30,
  WORKER_POLL_INTERVAL_MS: 2_000,
  WORKER_LEASE_SECONDS: 120,
  WORKER_MAX_ATTEMPTS: 8,
  PANEL_MUTATIONS_ENABLED: false,
  CUSTOMER_ORDERS_ENABLED: false,
  DEFAULT_LOCALE: "fa",
  LOG_LEVEL: "info",
};

const customer = createUser({ id: "customer-1", telegramId: 2001n, role: null });
const finance = createUser({ id: "finance-1", telegramId: 3001n, role: "finance" });
const owner = createUser({ id: "owner-1", telegramId: 1001n, role: "owner" });
const serverOperator = createUser({ id: "operator-1", telegramId: 4001n, role: "server_operator" });

const runningServers: Array<ReturnType<typeof createApiServer>> = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("API route integration", () => {
  it("serves liveness without touching persistence", async () => {
    const persistence = createPersistence();
    const response = await request(createDependencies(persistence), "/health/live");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "api" });
    expect(persistence.queryCount).toBe(0);
  });

  it("fails readiness closed when Redis is unavailable", async () => {
    const persistence = createPersistence();
    const response = await request(createDependencies(persistence, { redisReady: false }), "/health/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "redis_unavailable" });
    expect(persistence.queryCount).toBe(1);
  });

  it("rejects Telegram authentication without an exact same origin", async () => {
    const persistence = createPersistence();
    const response = await request(createDependencies(persistence), "/api/v1/auth/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: "signed-init-data" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "invalid_origin" });
    expect(persistence.redisIncrements).toBe(0);
  });

  it("limits Telegram authentication before verification or persistence", async () => {
    const persistence = createPersistence();
    const response = await request(createDependencies(persistence, { redisCount: 13 }), "/api/v1/auth/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: config.PUBLIC_BASE_URL,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ initData: "signed-init-data" }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
    expect(persistence.settingsUpserts).toBe(0);
  });

  it("requires authentication for customer data routes", async () => {
    const persistence = createPersistence();
    const response = await request(createDependencies(persistence), "/api/v1/plans");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "authentication_required" });
  });

  it("requires origin and matching CSRF values for authenticated mutations", async () => {
    const persistence = createPersistence({ sessionUser: customer });
    const response = await request(createDependencies(persistence), "/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: sessionCookies() },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "invalid_origin" });
    expect(persistence.sessionRevocations).toBe(0);
  });

  it("logs out an authenticated session with exact origin and valid CSRF", async () => {
    const persistence = createPersistence({ sessionUser: customer });
    const response = await request(createDependencies(persistence), "/api/v1/auth/logout", mutationOptions());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "signed_out" });
    expect(persistence.sessionRevocations).toBe(1);
    expect(response.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
  });

  it("enforces finance RBAC on review queues", async () => {
    const customerPersistence = createPersistence({ sessionUser: customer });
    const denied = await request(createDependencies(customerPersistence), "/api/v1/admin/reviews", {
      headers: { cookie: sessionCookies() },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "forbidden" });

    const financePersistence = createPersistence({ sessionUser: finance });
    const allowed = await request(createDependencies(financePersistence), "/api/v1/admin/reviews", {
      headers: { cookie: sessionCookies() },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([]);
  });

  it("blocks customer orders at the deployment safety gate", async () => {
    const persistence = createPersistence({ sessionUser: customer });
    const response = await request(createDependencies(persistence), "/api/v1/orders", {
      ...mutationOptions(),
      body: JSON.stringify({ planId: "plan-1", idempotencyKey: "integration:order:1234" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "orders_disabled" });
  });

  it("returns not-found for another customer's subscription configurations", async () => {
    const persistence = createPersistence({ sessionUser: customer });
    const response = await request(createDependencies(persistence), "/api/v1/subscriptions/not-owned/configs", {
      headers: { cookie: sessionCookies() },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "subscription_not_found" });
  });

  it("protects the last active recipient card from deactivation", async () => {
    const persistence = createPersistence({ sessionUser: finance, management: true });
    const response = await request(createDependencies(persistence), "/api/v1/admin/cards/card-1", {
      ...mutationOptions("PATCH"),
      body: JSON.stringify({ active: false, confirmation: "UPDATE RECIPIENT CARD" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "last_active_card" });
    expect(persistence.auditCreates).toBe(0);
  });

  it("updates plan eligibility only when inbound protocols match", async () => {
    const persistence = createPersistence({ sessionUser: owner, management: true });
    const response = await request(createDependencies(persistence), "/api/v1/admin/plans/plan-1", {
      ...mutationOptions("PATCH"),
      body: JSON.stringify({
        protocol: "vless",
        inboundIds: ["inbound-1"],
        confirmation: "UPDATE PLAN",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "plan-1", protocol: "vless" });
    expect(persistence.planEligibilityReplacements).toBe(1);
    expect(persistence.auditCreates).toBe(1);
  });

  it("probes a rotated panel token and synchronizes returned inbounds", async () => {
    const persistence = createPersistence({ sessionUser: serverOperator, management: true });
    let probed = false;
    const dependencies = createDependencies(persistence, {
      probePanel: (baseUrl, token) => {
        probed = baseUrl === "https://panel.test" && token === "rotated-panel-token-value";
        return Promise.resolve({
          inbounds: [{ id: 7, tag: "primary", remark: "Primary", protocol: "vless", port: 443 }],
        });
      },
    });
    const response = await request(dependencies, "/api/v1/admin/panels/panel-1", {
      ...mutationOptions("PATCH"),
      body: JSON.stringify({
        apiToken: "rotated-panel-token-value",
        synchronize: true,
        confirmation: "UPDATE PANEL",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "panel-1", synchronized: true });
    expect(probed).toBe(true);
    expect(persistence.inboundUpserts).toBe(1);
    expect(persistence.auditCreates).toBe(1);
  });

  it("rejects inbound capacity below current usage", async () => {
    const persistence = createPersistence({ sessionUser: serverOperator, management: true });
    const response = await request(createDependencies(persistence), "/api/v1/admin/inbounds/inbound-1", {
      ...mutationOptions("PATCH"),
      body: JSON.stringify({ capacity: 9, confirmation: "UPDATE INBOUND" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "capacity_below_usage" });
    expect(persistence.auditCreates).toBe(0);
  });
});

interface PersistenceState {
  queryCount: number;
  redisIncrements: number;
  settingsUpserts: number;
  sessionRevocations: number;
  auditCreates: number;
  planEligibilityReplacements: number;
  inboundUpserts: number;
}

function createPersistence(options: { sessionUser?: User; management?: boolean } = {}): PersistenceState & { prisma: ApiDependencies["prisma"] } {
  const state: PersistenceState = {
    queryCount: 0,
    redisIncrements: 0,
    settingsUpserts: 0,
    sessionRevocations: 0,
    auditCreates: 0,
    planEligibilityReplacements: 0,
    inboundUpserts: 0,
  };
  const sessionUser = options.sessionUser;
  const prisma = {
    $queryRaw: () => {
      state.queryCount += 1;
      return Promise.resolve([{ ok: 1 }]);
    },
    systemSettings: {
      findUnique: () => Promise.resolve({
        id: 1,
        setupCompletedAt: new Date("2026-07-30T00:00:00.000Z"),
        customerOrderMode: "disabled",
        customerOrdersEnabled: false,
      }),
      upsert: () => {
        state.settingsUpserts += 1;
        return Promise.resolve({ id: 1, setupCompletedAt: null, defaultLocale: "fa" });
      },
    },
    adminSession: {
      findUnique: () => Promise.resolve(sessionUser ? {
        id: "session-1",
        userId: sessionUser.id,
        tokenHash: hashOpaqueToken(SESSION_TOKEN, SESSION_SECRET),
        csrfHash: hashOpaqueToken(CSRF_TOKEN, SESSION_SECRET),
        expiresAt: new Date(Date.now() + 60_000),
        lastUsedAt: new Date(),
        revokedAt: null,
        createdAt: new Date(),
        user: sessionUser,
      } : null),
      update: () => {
        state.sessionRevocations += 1;
        return Promise.resolve({ id: "session-1" });
      },
    },
    order: {
      findMany: () => Promise.resolve([]),
    },
    subscription: {
      findFirst: () => Promise.resolve(null),
    },
    ...(options.management ? managementPersistence(state) : {}),
  } as unknown as ApiDependencies["prisma"];
  return Object.assign(state, { prisma });
}

function createDependencies(
  persistence: ReturnType<typeof createPersistence>,
  options: { redisReady?: boolean; redisCount?: number; probePanel?: ApiDependencies["probePanel"] } = {},
): ApiDependencies {
  const redisCount = options.redisCount ?? 1;
  return {
    config,
    prisma: persistence.prisma,
    redis: {
      isReady: options.redisReady ?? true,
      incr: () => {
        persistence.redisIncrements += 1;
        return Promise.resolve(redisCount);
      },
      expire: () => Promise.resolve(1),
      ping: () => Promise.resolve("PONG"),
    },
    verifyTelegram: () => ({
      authDate: new Date(),
      user: { id: 1001, isBot: false, firstName: "Owner" },
      raw: new URLSearchParams(),
    }),
    ...(options.probePanel ? { probePanel: options.probePanel } : {}),
  };
}

async function request(dependencies: ApiDependencies, path: string, init?: RequestInit): Promise<Response> {
  const server = createApiServer(dependencies);
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

function sessionCookies(): string {
  return `hollowcon_session=${SESSION_TOKEN}; hollowcon_csrf=${CSRF_TOKEN}`;
}

function mutationOptions(method = "POST"): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      cookie: sessionCookies(),
      origin: config.PUBLIC_BASE_URL,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": CSRF_TOKEN,
    },
  };
}

function managementPersistence(state: PersistenceState) {
  const plan = {
    id: "plan-1",
    slug: "plan-one",
    nameFa: "پلن یک",
    nameEn: "Plan one",
    priceRial: 100_000n,
    durationDays: 30,
    trafficBytes: 50_000_000_000n,
    deviceLimit: 2,
    protocol: "vless",
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const panel = {
    id: "panel-1",
    name: "Panel one",
    baseUrl: "https://panel.test",
    apiTokenEncrypted: "unused-by-token-rotation-test",
    apiTokenKeyId: "primary",
    expectedVersion: "3.5.0",
    enabled: true,
    weight: 100,
    consecutiveFailures: 0,
    circuitOpenUntil: null,
    lastHealthyAt: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const inbound = {
    id: "inbound-1",
    panelId: panel.id,
    remoteId: 7,
    tag: "primary",
    remark: "Primary",
    protocol: "vless",
    port: 443,
    enabled: true,
    capacity: 100,
    activeClients: 10,
    lastSyncedAt: new Date(),
  };
  const auditEvent = {
    create: () => {
      state.auditCreates += 1;
      return Promise.resolve({ id: `audit-${state.auditCreates}` });
    },
  };
  const planInbound = {
    deleteMany: () => {
      state.planEligibilityReplacements += 1;
      return Promise.resolve({ count: 1 });
    },
    createMany: () => Promise.resolve({ count: 1 }),
  };
  const panelInbound = {
    findMany: () => Promise.resolve([{ id: inbound.id, protocol: inbound.protocol }]),
    findUnique: () => Promise.resolve(inbound),
    update: ({ data }: { data: Partial<typeof inbound> }) => Promise.resolve({ ...inbound, ...data }),
    upsert: () => {
      state.inboundUpserts += 1;
      return Promise.resolve(inbound);
    },
  };
  const planStore = {
    findUnique: () => Promise.resolve(plan),
    update: ({ data }: { data: Partial<typeof plan> }) => Promise.resolve({ ...plan, ...data }),
  };
  const panelStore = {
    findUnique: () => Promise.resolve(panel),
    update: ({ data }: { data: Partial<typeof panel> }) => Promise.resolve({ ...panel, ...data }),
  };
  const recipientCard = {
    findUnique: () => Promise.resolve({
      id: "card-1",
      active: true,
      panEncrypted: "encrypted",
      panKeyId: "primary",
      panLastFour: "1234",
      cardholderName: "Test",
      pendingLimit: 100,
    }),
    count: () => Promise.resolve(1),
  };
  return {
    recipientCard,
    plan: planStore,
    panel: panelStore,
    panelInbound,
    planInbound,
    auditEvent,
    $transaction: (callback: (transaction: unknown) => Promise<unknown>) => callback({
      recipientCard,
      plan: planStore,
      panel: panelStore,
      panelInbound,
      planInbound,
      auditEvent,
    }),
  };
}

function createUser(input: Pick<User, "id" | "telegramId" | "role">): User {
  return {
    id: input.id,
    telegramId: input.telegramId,
    username: null,
    firstName: "Test user",
    phone: null,
    locale: "fa",
    role: input.role,
    roleAssignedAt: input.role ? new Date() : null,
    roleRevokedAt: null,
    disabledAt: null,
    termsAcceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
