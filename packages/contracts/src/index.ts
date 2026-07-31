import { z } from "zod";

export const localeSchema = z.enum(["fa", "en"]);
export const roleSchema = z.enum([
  "owner",
  "admin",
  "finance",
  "support",
  "server_operator",
  "marketing",
  "auditor",
]);
export const rialStringSchema = z.string().regex(/^(0|[1-9]\d*)$/u);
export const identifierSchema = z.string().min(8).max(64);

export const telegramAuthRequestSchema = z.object({
  initData: z.string().min(32).max(16_384),
});

export const meResponseSchema = z.object({
  id: identifierSchema,
  telegramId: z.string().regex(/^\d+$/u),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  locale: localeSchema,
  role: roleSchema.nullable(),
  termsAcceptedAt: z.iso.datetime().nullable(),
  csrfToken: z.string().min(32),
});

export const planSchema = z.object({
  id: identifierSchema,
  slug: z.string().min(1).max(80),
  nameFa: z.string().min(1).max(160),
  nameEn: z.string().min(1).max(160),
  priceRial: rialStringSchema,
  durationDays: z.number().int().positive().max(3_650),
  trafficBytes: rialStringSchema,
  deviceLimit: z.number().int().min(0).max(1_000),
  protocol: z.string().min(1).max(32),
});

export const createOrderRequestSchema = z.object({
  planId: identifierSchema,
  idempotencyKey: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9:_-]+$/u),
});

export const orderStatusSchema = z.enum([
  "draft",
  "awaiting_receipt",
  "under_review",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export const orderSchema = z.object({
  id: identifierSchema,
  status: orderStatusSchema,
  planNameFa: z.string(),
  planNameEn: z.string(),
  payableAmountRial: rialStringSchema,
  uniqueSuffixRial: z.number().int().min(1).max(999),
  recipientCardMasked: z.string(),
  reservationExpires: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const paymentReviewRequestSchema = z.object({
  approved: z.boolean(),
  reason: z.string().trim().min(3).max(1_000),
});

export const setupCardSchema = z.object({
  pan: z
    .string()
    .transform((value) => value.replace(/[\s-]/gu, ""))
    .pipe(z.string().regex(/^\d{16}$/u)),
  cardholderName: z.string().trim().min(2).max(160),
  pendingLimit: z.number().int().min(1).max(999).default(100),
});

export const setupPlanSchema = planSchema.omit({ id: true }).extend({
  active: z.boolean().default(true),
});

export const setupPanelSchema = z.object({
  name: z.string().trim().min(2).max(120),
  baseUrl: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "Panel URL must use HTTPS"),
  apiToken: z.string().min(16).max(8_192),
  expectedVersion: z.literal("3.5.0").default("3.5.0"),
});

export const setupEligibilitySchema = z.object({
  planId: identifierSchema,
  inboundIds: z.array(identifierSchema).min(1).max(100),
});

export const setupFinalizeSchema = z.object({
  termsVersion: z.string().min(1).max(32),
  supportContact: z.string().trim().min(3).max(160),
});

export const updateCardSchema = z
  .object({
    pan: setupCardSchema.shape.pan.optional(),
    cardholderName: setupCardSchema.shape.cardholderName.optional(),
    pendingLimit: setupCardSchema.shape.pendingLimit.optional(),
    active: z.boolean().optional(),
    confirmation: z.literal("UPDATE RECIPIENT CARD"),
  })
  .refine(
    (value) =>
      value.pan !== undefined ||
      value.cardholderName !== undefined ||
      value.pendingLimit !== undefined ||
      value.active !== undefined,
    "At least one card field must be updated",
  );

export const updatePlanSchema = setupPlanSchema
  .partial()
  .extend({
    inboundIds: z.array(identifierSchema).max(100).optional(),
    confirmation: z.literal("UPDATE PLAN"),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "confirmation"),
    "At least one plan field must be updated",
  );

export const updatePanelSchema = z
  .object({
    name: setupPanelSchema.shape.name.optional(),
    apiToken: setupPanelSchema.shape.apiToken.optional(),
    enabled: z.boolean().optional(),
    weight: z.number().int().min(1).max(10_000).optional(),
    synchronize: z.boolean().default(false),
    confirmation: z.literal("UPDATE PANEL"),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.apiToken !== undefined ||
      value.enabled !== undefined ||
      value.weight !== undefined ||
      value.synchronize,
    "At least one panel field must be updated",
  );

export const updateInboundSchema = z
  .object({
    enabled: z.boolean().optional(),
    capacity: z.number().int().min(1).max(1_000_000).nullable().optional(),
    confirmation: z.literal("UPDATE INBOUND"),
  })
  .refine(
    (value) => value.enabled !== undefined || value.capacity !== undefined,
    "At least one inbound field must be updated",
  );

export const errorResponseSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  correlationId: z.string().min(8),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type Locale = z.infer<typeof localeSchema>;
export type TelegramAuthRequest = z.infer<typeof telegramAuthRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type PlanResponse = z.infer<typeof planSchema>;
export type OrderResponse = z.infer<typeof orderSchema>;
export type PaymentReviewRequest = z.infer<typeof paymentReviewRequestSchema>;
