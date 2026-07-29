import { randomInt } from "node:crypto";

import type {
  Order,
  PaymentReceipt,
  PaymentReview,
  Prisma,
  PrismaClient,
  ProvisioningJob,
} from "@prisma/client";
import { payableAmount, rial, transitionOrder } from "@hollowcon/domain";

export const ORDER_PROVISIONING_REQUESTED = "order.provisioning.requested";

export class CommerceConflictError extends Error {}
export class CommerceNotFoundError extends Error {}
export class CommercePermissionError extends Error {}
export class CommerceValidationError extends Error {}

export interface CreateOrderInput {
  readonly userId: string;
  readonly planId: string;
  readonly recipientCardId: string;
  readonly reservationMinutes: number;
  readonly uniqueSuffixMin?: number;
  readonly uniqueSuffixMax?: number;
  readonly now?: Date;
}

export interface SubmitReceiptInput {
  readonly orderId: string;
  readonly storageKey: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly perceptualHash?: string;
  readonly now?: Date;
}

export interface ReviewPaymentInput {
  readonly orderId: string;
  readonly reviewerId: string;
  readonly approved: boolean;
  readonly reason: string;
  readonly correlationId: string;
  readonly now?: Date;
}

export interface ApprovalResult {
  readonly order: Order;
  readonly review: PaymentReview;
  readonly provisioning: ProvisioningJob | null;
  readonly alreadyFinalized: boolean;
}

type TransactionClient = Prisma.TransactionClient;
type DatabaseClient = Pick<PrismaClient, "$transaction">;
type SuffixGenerator = (minimum: number, maximumExclusive: number) => number;

const MAX_SUFFIX_ALLOCATION_ATTEMPTS = 20;
const MIN_RESERVATION_MINUTES = 5;
const MAX_RESERVATION_MINUTES = 1440;
const MIN_RECEIPT_BYTES = 1_024;
const MAX_RECEIPT_BYTES = 16_777_216;
const RECEIPT_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export class CommerceService {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly suffixGenerator: SuffixGenerator = randomInt,
  ) {}

  public async createOrder(input: CreateOrderInput): Promise<Order> {
    const now = input.now ?? new Date();
    const reservationMinutes = requireIntegerRange(
      input.reservationMinutes,
      MIN_RESERVATION_MINUTES,
      MAX_RESERVATION_MINUTES,
      "reservationMinutes",
    );
    const minimum = requireIntegerRange(input.uniqueSuffixMin ?? 1, 1, 999, "uniqueSuffixMin");
    const maximum = requireIntegerRange(input.uniqueSuffixMax ?? 999, 1, 999, "uniqueSuffixMax");
    if (minimum > maximum) {
      throw new CommerceValidationError("uniqueSuffixMin cannot exceed uniqueSuffixMax");
    }

    return this.database.$transaction(async (transaction) => {
      const [plan, recipientCard] = await Promise.all([
        transaction.plan.findUnique({ where: { id: input.planId } }),
        transaction.recipientCard.findUnique({ where: { id: input.recipientCardId } }),
      ]);
      if (!plan?.active) {
        throw new CommerceNotFoundError("Active plan not found");
      }
      if (!recipientCard?.active) {
        throw new CommerceNotFoundError("Active recipient card not found");
      }

      const pendingOrders = await transaction.order.count({
        where: {
          recipientCardId: recipientCard.id,
          status: { in: ["draft", "awaiting_receipt", "under_review"] },
          reservationExpires: { gt: now },
        },
      });
      if (pendingOrders >= recipientCard.pendingLimit) {
        throw new CommerceConflictError("Recipient card has reached its pending-order limit");
      }

      const reservationExpires = new Date(now.getTime() + reservationMinutes * 60_000);
      const occupied = await transaction.order.findMany({
        where: {
          recipientCardId: recipientCard.id,
          reservationExpires: { gt: now },
          status: { in: ["draft", "awaiting_receipt", "under_review"] },
          uniqueSuffixRial: { gte: minimum, lte: maximum },
        },
        select: { uniqueSuffixRial: true },
      });
      const occupiedSuffixes = new Set(occupied.map(({ uniqueSuffixRial }) => uniqueSuffixRial));

      for (let attempt = 0; attempt < MAX_SUFFIX_ALLOCATION_ATTEMPTS; attempt += 1) {
        const suffix = this.suffixGenerator(minimum, maximum + 1);
        if (occupiedSuffixes.has(suffix)) {
          continue;
        }
        occupiedSuffixes.add(suffix);
        const baseAmount = rial(bigIntToSafeNumber(plan.priceRial, "Plan price"));
        const payable = payableAmount(baseAmount, suffix);

        try {
          return await transaction.order.create({
            data: {
              userId: input.userId,
              planId: plan.id,
              recipientCardId: recipientCard.id,
              status: transitionOrder("draft", "awaiting_receipt"),
              baseAmountRial: plan.priceRial,
              uniqueSuffixRial: suffix,
              payableAmountRial: BigInt(payable),
              reservationExpires,
            },
          });
        } catch (error: unknown) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }
        }
      }

      throw new CommerceConflictError("No unique payment amount is currently available");
    });
  }

  public async submitReceipt(input: SubmitReceiptInput): Promise<PaymentReceipt> {
    const mediaType = input.mediaType.toLowerCase();
    if (!RECEIPT_MEDIA_TYPES.has(mediaType)) {
      throw new CommerceValidationError("Unsupported receipt media type");
    }
    requireIntegerRange(input.byteSize, MIN_RECEIPT_BYTES, MAX_RECEIPT_BYTES, "byteSize");
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new CommerceValidationError("sha256 must be a lowercase hexadecimal SHA-256 digest");
    }

    const now = input.now ?? new Date();
    return this.database.$transaction(async (transaction) => {
      await lockOrder(transaction, input.orderId);
      const order = await transaction.order.findUnique({ where: { id: input.orderId } });
      if (!order) {
        throw new CommerceNotFoundError("Order not found");
      }
      if (order.reservationExpires <= now) {
        if (order.status === "awaiting_receipt") {
          await transaction.order.update({
            where: { id: order.id },
            data: { status: transitionOrder("awaiting_receipt", "expired"), version: { increment: 1 } },
          });
        }
        throw new CommerceConflictError("Payment reservation has expired");
      }
      if (order.status !== "awaiting_receipt" && order.status !== "rejected") {
        throw new CommerceConflictError(`Order cannot accept a receipt while ${order.status}`);
      }

      const receipt = await transaction.paymentReceipt.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          storageKey: input.storageKey,
          mediaType,
          byteSize: input.byteSize,
          sha256: input.sha256,
          ...(input.perceptualHash ? { perceptualHash: input.perceptualHash } : {}),
          submittedAt: now,
        },
        update: {
          storageKey: input.storageKey,
          mediaType,
          byteSize: input.byteSize,
          sha256: input.sha256,
          perceptualHash: input.perceptualHash ?? null,
          submittedAt: now,
        },
      });

      await transaction.order.update({
        where: { id: order.id },
        data: { status: transitionOrder(order.status, "under_review"), version: { increment: 1 } },
      });
      return receipt;
    });
  }

  public async reviewPayment(input: ReviewPaymentInput): Promise<ApprovalResult> {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 1_000) {
      throw new CommerceValidationError("Review reason must be between 3 and 1000 characters");
    }
    if (input.correlationId.trim().length < 8) {
      throw new CommerceValidationError("correlationId must contain at least 8 characters");
    }

    const now = input.now ?? new Date();
    return this.database.$transaction(async (transaction) => {
      await lockOrder(transaction, input.orderId);
      const order = await transaction.order.findUnique({ where: { id: input.orderId } });
      if (!order) {
        throw new CommerceNotFoundError("Order not found");
      }
      const reviewer = await transaction.user.findUnique({ where: { id: input.reviewerId } });
      if (!reviewer?.role || !canReviewPayments(reviewer.role)) {
        throw new CommercePermissionError("Reviewer is not allowed to review payments");
      }

      if (order.status === "approved" || order.status === "rejected") {
        const existingReview = await transaction.paymentReview.findFirst({
          where: { orderId: order.id },
          orderBy: { createdAt: "desc" },
        });
        if (!existingReview || existingReview.approved !== input.approved) {
          throw new CommerceConflictError(`Order is already ${order.status}`);
        }
        return {
          order,
          review: existingReview,
          provisioning: await transaction.provisioningJob.findUnique({ where: { orderId: order.id } }),
          alreadyFinalized: true,
        };
      }

      if (order.status !== "under_review") {
        throw new CommerceConflictError(`Order cannot be reviewed while ${order.status}`);
      }
      const receipt = await transaction.paymentReceipt.findUnique({ where: { orderId: order.id } });
      if (!receipt) {
        throw new CommerceConflictError("Order has no receipt to review");
      }

      const targetStatus = transitionOrder("under_review", input.approved ? "approved" : "rejected");
      const review = await transaction.paymentReview.create({
        data: {
          orderId: order.id,
          reviewerId: reviewer.id,
          approved: input.approved,
          reason,
          createdAt: now,
        },
      });
      const updatedOrder = await transaction.order.update({
        where: { id: order.id },
        data: {
          status: targetStatus,
          approvedAt: input.approved ? now : null,
          version: { increment: 1 },
        },
      });

      let provisioning: ProvisioningJob | null = null;
      if (input.approved) {
        const idempotencyKey = `provision-order:${order.id}`;
        provisioning = await transaction.provisioningJob.upsert({
          where: { orderId: order.id },
          create: { orderId: order.id, idempotencyKey },
          update: {},
        });
        await transaction.outboxEvent.upsert({
          where: { idempotencyKey },
          create: {
            aggregateType: "order",
            aggregateId: order.id,
            eventType: ORDER_PROVISIONING_REQUESTED,
            idempotencyKey,
            payload: { orderId: order.id, provisioningJobId: provisioning.id },
          },
          update: {},
        });
      }

      await transaction.auditEvent.create({
        data: {
          actorId: reviewer.id,
          action: input.approved ? "payment.approved" : "payment.rejected",
          subjectType: "order",
          subjectId: order.id,
          reason,
          correlationId: input.correlationId,
          metadata: {
            reviewId: review.id,
            receiptId: receipt.id,
            payableAmountRial: order.payableAmountRial.toString(),
          },
        },
      });

      return { order: updatedOrder, review, provisioning, alreadyFinalized: false };
    }, { isolationLevel: "Serializable" });
  }
}

async function lockOrder(transaction: TransactionClient, orderId: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new CommerceNotFoundError("Order not found");
  }
}

function canReviewPayments(role: "owner" | "admin" | "finance" | "support" | "server_operator" | "marketing" | "auditor"): boolean {
  return role === "owner" || role === "admin" || role === "finance";
}

function requireIntegerRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CommerceValidationError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function bigIntToSafeNumber(value: bigint, name: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new CommerceValidationError(`${name} exceeds the supported safe integer range`);
  }
  return numberValue;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
