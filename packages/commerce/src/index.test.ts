import { describe, expect, it } from "vitest";

import {
  CommerceConflictError,
  CommerceService,
  CommerceValidationError,
  ORDER_PROVISIONING_REQUESTED,
} from "./index.js";

interface TestState {
  status: "under_review" | "approved" | "rejected";
  reviews: Array<{ id: string; orderId: string; reviewerId: string; approved: boolean; reason: string; createdAt: Date }>;
  provisioning: { id: string; orderId: string; idempotencyKey: string } | null;
  outbox: { idempotencyKey: string; eventType: string } | null;
  auditCount: number;
}

function createApprovalDatabase(state: TestState): ConstructorParameters<typeof CommerceService>[0] {
  const order = () => ({
    id: "order-1",
    userId: "customer-1",
    planId: "plan-1",
    recipientCardId: "card-1",
    status: state.status,
    baseAmountRial: 1_000_000n,
    uniqueSuffixRial: 231,
    payableAmountRial: 1_000_231n,
    idempotencyKey: "legacy:order-1",
    planNameFa: "پلن آزمایشی",
    planNameEn: "Test plan",
    durationDays: 30,
    trafficBytes: 10_000_000_000n,
    deviceLimit: 1,
    protocol: "vless",
    reservationExpires: new Date("2026-07-29T09:00:00.000Z"),
    version: state.status === "under_review" ? 1 : 2,
    approvedAt: state.status === "approved" ? new Date("2026-07-29T08:00:00.000Z") : null,
    createdAt: new Date("2026-07-29T07:00:00.000Z"),
    updatedAt: new Date("2026-07-29T07:30:00.000Z"),
  });

  const transaction = {
    $queryRaw: () => Promise.resolve([{ id: "order-1" }]),
    order: {
      findUnique: () => Promise.resolve(order()),
      update: (argument: { data: { status: TestState["status"] } }) => {
        state.status = argument.data.status;
        return Promise.resolve(order());
      },
    },
    user: {
      findUnique: () => Promise.resolve({ id: "finance-1", role: "finance" }),
    },
    paymentReceipt: {
      findFirst: () => Promise.resolve({ id: "receipt-1", orderId: "order-1" }),
    },
    paymentReview: {
      create: (argument: { data: Omit<TestState["reviews"][number], "id"> }) => {
        const review = { id: `review-${state.reviews.length + 1}`, ...argument.data };
        state.reviews.push(review);
        return Promise.resolve(review);
      },
      findFirst: () => Promise.resolve(state.reviews.at(-1) ?? null),
    },
    provisioningJob: {
      upsert: () => {
        state.provisioning ??= {
          id: "provisioning-1",
          orderId: "order-1",
          idempotencyKey: "provision-order:order-1",
        };
        return Promise.resolve({
          ...state.provisioning,
          status: "queued",
          attempts: 0,
          nextAttemptAt: new Date("2026-07-29T08:00:00.000Z"),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorSafe: null,
          lockedAt: null,
          deliveredAt: null,
          createdAt: new Date("2026-07-29T08:00:00.000Z"),
          updatedAt: new Date("2026-07-29T08:00:00.000Z"),
        });
      },
      findUnique: () =>
        Promise.resolve(
          state.provisioning
            ? {
                ...state.provisioning,
                status: "queued",
                attempts: 0,
                nextAttemptAt: new Date("2026-07-29T08:00:00.000Z"),
                leaseOwner: null,
                leaseExpiresAt: null,
                lastErrorCode: null,
                lastErrorSafe: null,
                lockedAt: null,
                deliveredAt: null,
                createdAt: new Date("2026-07-29T08:00:00.000Z"),
                updatedAt: new Date("2026-07-29T08:00:00.000Z"),
              }
            : null,
        ),
    },
    outboxEvent: {
      upsert: (argument: { create: { idempotencyKey: string; eventType: string } }) => {
        state.outbox ??= argument.create;
        return Promise.resolve(state.outbox);
      },
    },
    auditEvent: {
      create: () => {
        state.auditCount += 1;
        return Promise.resolve({ id: `audit-${state.auditCount}` });
      },
    },
  };

  let transactionQueue = Promise.resolve();
  return {
    $transaction: <T>(callback: (client: typeof transaction) => Promise<T>) => {
      const result = transactionQueue.then(() => callback(transaction));
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as ConstructorParameters<typeof CommerceService>[0];
}

describe("CommerceService payment review", () => {
  it("approves once and creates one provisioning identity plus one outbox event", async () => {
    const state: TestState = {
      status: "under_review",
      reviews: [],
      provisioning: null,
      outbox: null,
      auditCount: 0,
    };
    const service = new CommerceService(createApprovalDatabase(state));
    const input = {
      orderId: "order-1",
      reviewerId: "finance-1",
      approved: true,
      reason: "Transfer verified against bank records",
      correlationId: "request-1234",
      now: new Date("2026-07-29T08:00:00.000Z"),
    } as const;

    const first = await service.reviewPayment(input);
    const second = await service.reviewPayment(input);

    expect(first.alreadyFinalized).toBe(false);
    expect(second.alreadyFinalized).toBe(true);
    expect(state.reviews).toHaveLength(1);
    expect(state.provisioning?.idempotencyKey).toBe("provision-order:order-1");
    expect(state.outbox).toMatchObject({
      idempotencyKey: "provision-order:order-1",
      eventType: ORDER_PROVISIONING_REQUESTED,
    });
    expect(state.auditCount).toBe(1);
  });

  it("serializes concurrent duplicate approvals into one financial decision", async () => {
    const state: TestState = {
      status: "under_review",
      reviews: [],
      provisioning: null,
      outbox: null,
      auditCount: 0,
    };
    const service = new CommerceService(createApprovalDatabase(state));
    const input = {
      orderId: "order-1",
      reviewerId: "finance-1",
      approved: true,
      reason: "Transfer verified against bank records",
      correlationId: "request-concurrent",
    } as const;

    const [first, second] = await Promise.all([
      service.reviewPayment(input),
      service.reviewPayment(input),
    ]);

    expect([first.alreadyFinalized, second.alreadyFinalized].sort()).toEqual([false, true]);
    expect(state.reviews).toHaveLength(1);
    expect(state.auditCount).toBe(1);
  });

  it("rejects a conflicting decision after finalization", async () => {
    const state: TestState = {
      status: "approved",
      reviews: [
        {
          id: "review-1",
          orderId: "order-1",
          reviewerId: "finance-1",
          approved: true,
          reason: "Verified",
          createdAt: new Date("2026-07-29T08:00:00.000Z"),
        },
      ],
      provisioning: null,
      outbox: null,
      auditCount: 0,
    };
    const service = new CommerceService(createApprovalDatabase(state));

    await expect(
      service.reviewPayment({
        orderId: "order-1",
        reviewerId: "finance-1",
        approved: false,
        reason: "Conflicting rejection",
        correlationId: "request-5678",
      }),
    ).rejects.toBeInstanceOf(CommerceConflictError);
  });

  it("validates receipt metadata before touching persistence", async () => {
    const database = {
      $transaction: () => Promise.reject(new Error("should not be called")),
    } as unknown as ConstructorParameters<typeof CommerceService>[0];
    const service = new CommerceService(database);

    await expect(
      service.submitReceipt({
        orderId: "order-1",
        storageKey: "receipts/order-1.exe",
        mediaType: "application/x-msdownload",
        detectedMediaType: "application/x-msdownload",
        byteSize: 2_048,
        sha256: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(CommerceValidationError);
  });
});
