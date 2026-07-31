import type { User } from "@prisma/client";
import { hashOpaqueToken } from "@hollowcon/security";
import { describe, expect, it } from "vitest";

import { authenticateSession, clearSessionCookies, csrfCookie, requireRole, sessionCookie, verifyCsrfToken } from "./sessions.js";

const secret = "test-session-secret-with-sufficient-entropy";

function user(role: User["role"]): User {
  return {
    id: "user-1",
    telegramId: 1n,
    username: null,
    firstName: "Zero",
    phone: null,
    locale: "en",
    role,
    roleAssignedAt: null,
    roleRevokedAt: null,
    disabledAt: null,
    termsAcceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("session and CSRF helpers", () => {
  it("creates secure session and readable CSRF cookies", () => {
    const expires = new Date(Date.now() + 60_000);
    const session = sessionCookie("opaque", expires);
    const csrf = csrfCookie("csrf", expires);

    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("Secure");
  });

  it("clears both authentication cookies with matching security attributes", () => {
    const cookies = clearSessionCookies();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0") && cookie.includes("Secure") && cookie.includes("SameSite=Lax"))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("hollowcon_session="))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("hollowcon_csrf="))).toBe(true);
  });

  it("validates a CSRF token against its stored hash", () => {
    const token = "c".repeat(48);
    const hash = hashOpaqueToken(token, secret);
    expect(() => verifyCsrfToken(token, hash, secret)).not.toThrow();
    expect(() => verifyCsrfToken("d".repeat(48), hash, secret)).toThrowError("CSRF validation failed");
    expect(() => verifyCsrfToken(undefined, hash, secret)).toThrowError("CSRF validation failed");
  });

  it("authorizes only explicitly allowed staff roles", () => {
    expect(requireRole(user("finance"), ["owner", "admin", "finance"])).toBe("finance");
    expect(() => requireRole(user("support"), ["owner", "finance"])).toThrowError("You are not allowed to perform this action");
    expect(() => requireRole(user(null), ["owner"])).toThrowError("You are not allowed to perform this action");
  });

  it("rejects an existing session immediately after the account is disabled", async () => {
    const disabled = { ...user("finance"), disabledAt: new Date() };
    const database = {
      adminSession: {
        findUnique: () => Promise.resolve({ id: "session-1", user: disabled, csrfHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000), revokedAt: null }),
        update: () => Promise.resolve(),
      },
    } as unknown as Parameters<typeof authenticateSession>[0];
    await expect(authenticateSession(database, "opaque-token-with-at-least-thirty-two-characters", secret, false)).rejects.toMatchObject({ status: 403, code: "account_disabled" });
  });
});
