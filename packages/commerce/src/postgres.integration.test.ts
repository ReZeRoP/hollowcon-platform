import { randomUUID } from "node:crypto";

import { PrismaClient, type User } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CommerceConflictError,
  CommerceService,
  ORDER_PROVISIONING_REQUESTED,
} from "./index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeWithDatabase = databaseUrl ? describe : describe.skip;

interface Fixture {
  readonly namespace: string;
  readonly customer: User;
  readonly finance: User;
  readonly planId: string;
  readonly recipientCardId: string;
}

const prisma = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : null;

describeWithDatabase.sequential("CommerceService PostgreSQL concurrency", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    if (!prisma) return;

    const namespace = `it-${randomUUID()}`;
    const telegramSeed = BigInt(`8${Date.now()}${Math.floor(Math.random() * 1_000)}`);
    const customer = await prisma.user.create({
      data: { telegramId: telegramSeed, username: `${namespace}-customer` },
    });
    const finance = await prisma.user.create({
      data: { telegramId: telegramSeed + 1n, username: `${namespace}-finance`, role: "finance" },
    });
    const plan = await prisma.plan.create({
      data: {
        slug: `${namespace}-plan`,
        nameFa: "پلن یکپارچه‌سازی",
        nameEn: "Integration plan",
        priceRial: 1_000_000n,
        durationDays: 30,
        trafficBytes: 10_000_000_000n,
        deviceLimit: 1,
        protocol: "vless",
      },
    });
    const recipientCard = await prisma.recipientCard.create({
      data: {
        panEncrypted: "integration-test-ciphertext",
        panLastFour: "1234",
        cardholderName: "Integration Test",
        pendingLimit: 100,
      },
    });

    fixture = {
      namespace,
      customer,
      finance,
      planId: plan.id,
      recipientCardId: recipientCard.id,
    };
  });

  afterAll(async () => {
    if (!prisma || !fixture) return;

    const orderIds = (
      await prisma.order.findMany({ where: { userId: fixture.customer.id }, select: { id: true } })
    ).map(({ id }) => id);
    await prisma.auditEvent.deleteMany({ where: { correlationId: { startsWith: fixture.namespace } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
    await prisma.paymentReview.deleteMany({ where: { order: { userId: fixture.customer.id } } });
    await prisma.paymentReceipt.deleteMany({ where: { order: { userId: fixture.customer.id } } });
    await prisma.provisioningJob.deleteMany({ where: { order: { userId: fixture.customer.id } } });
    await prisma.order.deleteMany({ where: { userId: fixture.customer.id } });
    await prisma.plan.delete({ where: { id: fixture.planId } });
    await prisma.recipientCard.delete({ where: { id: fixture.recipientCardId } });
    await prisma.user.deleteMany({ where: { id: { in: [fixture.customer.id, fixture.finance.id] } } });
    await prisma.$disconnect();
  });

  it("serializes concurrent allocations and preserves unique exact rial suffixes", async () => {
    if (!prisma) return;

    let nextSuffix = 409;
    const service = new CommerceService(prisma, () => {
      nextSuffix += 1;
      return nextSuffix;
    });
    const now = new Date();
    const orders = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.createOrder({
          userId: fixture.customer.id,
          planId: fixture.planId,
          recipientCardId: fixture.recipientCardId,
          idempotencyKey: `${fixture.namespace}:suffix:${index}`,
          reservationMinutes: 30,
          uniqueSuffixMin: 410,
          uniqueSuffixMax: 430,
          now,
        }),
      ),
    );

    expect(new Set(orders.map((order) => order.uniqueSuffixRial))).toHaveLength(orders.length);
    for (const order of orders) {
      expect(order.payableAmountRial).toBe(order.baseAmountRial + BigInt(order.uniqueSuffixRial));
    }
  });

  it("does not allow concurrent orders to exceed the recipient-card pending limit", async () => {
    if (!prisma) return;

    const limitedCard = await prisma.recipientCard.create({
      data: {
        panEncrypted: "integration-test-limited-card",
        panLastFour: "5678",
        cardholderName: "Limited Integration Test",
        pendingLimit: 1,
      },
    });
    const service = new CommerceService(prisma);

    try {
      const results = await Promise.allSettled([
        service.createOrder({
          userId: fixture.customer.id,
          planId: fixture.planId,
          recipientCardId: limitedCard.id,
          idempotencyKey: `${fixture.namespace}:limit:one`,
          reservationMinutes: 30,
        }),
        service.createOrder({
          userId: fixture.customer.id,
          planId: fixture.planId,
          recipientCardId: limitedCard.id,
          idempotencyKey: `${fixture.namespace}:limit:two`,
          reservationMinutes: 30,
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(CommerceConflictError);
      expect(await prisma.order.count({ where: { recipientCardId: limitedCard.id } })).toBe(1);
    } finally {
      await prisma.order.deleteMany({ where: { recipientCardId: limitedCard.id } });
      await prisma.recipientCard.delete({ where: { id: limitedCard.id } });
    }
  });

  it("creates one review, provisioning job, and outbox event under concurrent approval", async () => {
    if (!prisma) return;

    const service = new CommerceService(prisma);
    const order = await service.createOrder({
      userId: fixture.customer.id,
      planId: fixture.planId,
      recipientCardId: fixture.recipientCardId,
      idempotencyKey: `${fixture.namespace}:approval:order`,
      reservationMinutes: 30,
    });
    await service.submitReceipt({
      orderId: order.id,
      storageKey: `integration/${fixture.namespace}/${order.id}.png`,
      mediaType: "image/png",
      detectedMediaType: "image/png",
      byteSize: 2_048,
      sha256: "a".repeat(64),
    });

    const input = {
      orderId: order.id,
      reviewerId: fixture.finance.id,
      approved: true,
      reason: "Transfer verified against bank records",
      correlationId: `${fixture.namespace}:approval`,
    } as const;
    const results = await Promise.allSettled([
      service.reviewPayment(input),
      service.reviewPayment(input),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    expect(fulfilled.map((result) => result.alreadyFinalized).sort()).toEqual([false, true]);
    expect(await prisma.paymentReview.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.provisioningJob.count({ where: { orderId: order.id } })).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: order.id, eventType: ORDER_PROVISIONING_REQUESTED },
      }),
    ).toBe(1);
  });
});
