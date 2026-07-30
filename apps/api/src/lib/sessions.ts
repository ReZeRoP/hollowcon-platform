import { timingSafeEqual } from "node:crypto";

import type { PrismaClient, Role, User } from "@prisma/client";
import { generateOpaqueToken, hashOpaqueToken } from "@hollowcon/security";

import { ApiError } from "./http.js";

export const SESSION_COOKIE = "hollowcon_session";

export interface AuthenticatedSession {
  readonly id: string;
  readonly user: User;
  readonly csrfHash: string;
  readonly expiresAt: Date;
}

export async function createSession(
  prisma: PrismaClient,
  userId: string,
  sessionSecret: string,
  ttlSeconds: number,
): Promise<{ readonly token: string; readonly csrfToken: string; readonly expiresAt: Date }> {
  const token = generateOpaqueToken();
  const csrfToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
  await prisma.adminSession.create({
    data: {
      userId,
      tokenHash: hashOpaqueToken(token, sessionSecret),
      csrfHash: hashOpaqueToken(csrfToken, sessionSecret),
      expiresAt,
    },
  });
  return { token, csrfToken, expiresAt };
}

export async function authenticateSession(
  prisma: PrismaClient,
  token: string | undefined,
  sessionSecret: string,
  touch = true,
): Promise<AuthenticatedSession> {
  if (!token) throw new ApiError(401, "authentication_required", "Telegram authentication is required");
  const tokenHash = hashOpaqueToken(token, sessionSecret);
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw new ApiError(401, "invalid_session", "Your session has expired");
  }
  if (touch) {
    await prisma.adminSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  }
  return { id: session.id, user: session.user, csrfHash: session.csrfHash, expiresAt: session.expiresAt };
}

export function verifyCsrfToken(supplied: string | undefined, csrfHash: string, sessionSecret: string): void {
  if (!supplied || supplied.length < 32) throw new ApiError(403, "csrf_failed", "CSRF validation failed");
  const actual = hashOpaqueToken(supplied, sessionSecret);
  const expectedBytes = Buffer.from(csrfHash, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new ApiError(403, "csrf_failed", "CSRF validation failed");
  }
}

export function requireRole(user: User, roles: readonly Role[]): Role {
  if (!user.role || !roles.includes(user.role)) {
    throw new ApiError(403, "forbidden", "You are not allowed to perform this action");
  }
  return user.role;
}

export function sessionCookie(value: string, expiresAt: Date): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}; Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000))}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
