import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_BASE_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.url(),
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(32),
  TELEGRAM_MINI_APP_URL: z.url(),
  INITIAL_OWNER_TELEGRAM_ID: z.coerce.bigint().positive(),
  PANEL_CREDENTIAL_MASTER_KEY: z.string().min(32),
  ADMIN_SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(43_200),
  TELEGRAM_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  RECEIPT_STORAGE_PATH: z.string().min(1),
  RECEIPT_MAX_BYTES: z.coerce.number().int().min(1_024).max(16_777_216).default(8_388_608),
  RECEIPT_ALLOWED_MEDIA_TYPES: z.string().default("image/jpeg,image/png,image/webp,application/pdf"),
  PAYMENT_UNIQUE_SUFFIX_MIN: z.coerce.number().int().min(1).default(1),
  PAYMENT_UNIQUE_SUFFIX_MAX: z.coerce.number().int().max(999).default(999),
  PAYMENT_RESERVATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(15).max(3_600).default(120),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  PANEL_MUTATIONS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CUSTOMER_ORDERS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  DEFAULT_LOCALE: z.enum(["fa", "en"]).default("fa"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(environment);
  if (config.PAYMENT_UNIQUE_SUFFIX_MIN > config.PAYMENT_UNIQUE_SUFFIX_MAX) {
    throw new Error("PAYMENT_UNIQUE_SUFFIX_MIN cannot exceed PAYMENT_UNIQUE_SUFFIX_MAX");
  }
  return config;
}
