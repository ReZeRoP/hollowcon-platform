import { describe, expect, it, vi } from "vitest";

import { enforceRateLimit, requestIdentity, type RateLimitStore } from "./rate-limit.js";

function client(count: number): RateLimitStore {
  return {
    incr: vi.fn().mockResolvedValue(count),
    expire: vi.fn().mockResolvedValue(true),
  };
}

describe("Redis-backed API rate limiting", () => {
  it("increments a privacy-preserving bucket and sets expiry on first use", async () => {
    const redis = client(1);
    await enforceRateLimit(redis, { name: "auth", limit: 3, windowSeconds: 60 }, "203.0.113.10");
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^hollowcon:rate:auth:[a-f0-9]{32}:\d+$/u));
    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 65);
  });

  it("returns 429 after the policy limit", async () => {
    await expect(enforceRateLimit(client(4), { name: "auth", limit: 3, windowSeconds: 60 }, "user-1")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("fails closed when Redis protection is unavailable", async () => {
    const redis = { incr: vi.fn().mockRejectedValue(new Error("contains connection details")) } as unknown as RateLimitStore;
    await expect(enforceRateLimit(redis, { name: "auth", limit: 3, windowSeconds: 60 }, "user-1")).rejects.toMatchObject({ status: 503, code: "rate_limit_unavailable" });
  });

  it("uses the first proxy-provided address with a socket fallback", () => {
    expect(requestIdentity({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" }, "127.0.0.1")).toBe("203.0.113.1");
    expect(requestIdentity({}, "127.0.0.1")).toBe("127.0.0.1");
  });
});
