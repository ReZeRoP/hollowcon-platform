import { createHash } from "node:crypto";

import { ApiError } from "./http.js";

export interface RateLimitStore {
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
}

export interface RateLimitPolicy {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export async function enforceRateLimit(redis: RateLimitStore, policy: RateLimitPolicy, identity: string): Promise<void> {
  const bucket = Math.floor(Date.now() / (policy.windowSeconds * 1_000));
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const key = `hollowcon:rate:${policy.name}:${digest}:${bucket}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, policy.windowSeconds + 5);
    if (count > policy.limit) {
      throw new ApiError(429, "rate_limited", "Too many requests. Please try again later");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "rate_limit_unavailable", "Request protection is temporarily unavailable");
  }
}

export function requestIdentity(headers: Readonly<Record<string, string | string[] | undefined>>, remoteAddress: string | undefined): string {
  const forwarded = headers["x-forwarded-for"];
  const candidate = typeof forwarded === "string" ? forwarded.split(",", 1)[0]?.trim() : undefined;
  return candidate || remoteAddress || "unknown";
}
