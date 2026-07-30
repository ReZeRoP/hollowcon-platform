import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class ApiError extends Error {
  public constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly correlationId: string;
}

export function createContext(request: IncomingMessage, response: ServerResponse): RequestContext {
  const supplied = request.headers["x-request-id"];
  const correlationId = typeof supplied === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(supplied)
    ? supplied
    : randomUUID();
  response.setHeader("x-request-id", correlationId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  return { request, response, correlationId };
}

export async function readJson(request: IncomingMessage, maximumBytes = 65_536): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Request body must be JSON");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maximumBytes) {
      throw new ApiError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204).end();
}

export function sendApiError(context: RequestContext, error: unknown): void {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "internal_error", "An unexpected server error occurred");
  if (apiError.status >= 500) {
    console.error(JSON.stringify({
      level: "error",
      service: "api",
      event: "request.failed",
      correlationId: context.correlationId,
      error: error instanceof Error ? error.message : "unknown",
    }));
  }
  sendJson(context.response, apiError.status, {
    error: apiError.code,
    message: apiError.message,
    correlationId: context.correlationId,
  });
}

export function parseCookies(request: IncomingMessage): ReadonlyMap<string, string> {
  const source = request.headers.cookie;
  const result = new Map<string, string>();
  if (!source) return result;
  for (const entry of source.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key && value) result.set(key, value);
  }
  return result;
}

export function requireSameOrigin(request: IncomingMessage, publicBaseUrl: string): void {
  const origin = request.headers.origin;
  if (origin && origin !== publicBaseUrl) {
    throw new ApiError(403, "invalid_origin", "Request origin is not allowed");
  }
}

export function requireCsrf(request: IncomingMessage, expected: string): void {
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || supplied.length < 32 || supplied !== expected) {
    throw new ApiError(403, "csrf_failed", "CSRF validation failed");
  }
}
