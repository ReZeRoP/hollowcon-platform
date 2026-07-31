import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { ApiError, parseCookies, readJson, requireCsrf, requireSameOrigin } from "./http.js";

function request(headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function bodyRequest(body: string, contentType = "application/json"): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, { headers: { "content-type": contentType } });
  stream.end(body);
  return stream as unknown as IncomingMessage;
}

describe("HTTP security helpers", () => {
  it("accepts only the exact configured origin", () => {
    expect(() => requireSameOrigin(request({ origin: "https://vpn.example.com", "sec-fetch-site": "same-origin" }), "https://vpn.example.com/app")).not.toThrow();
    expect(() => requireSameOrigin(request({ origin: "https://evil.example.com" }), "https://vpn.example.com")).toThrowError(ApiError);
    expect(() => requireSameOrigin(request(), "https://vpn.example.com")).toThrowError(ApiError);
  });

  it("rejects cross-site fetch metadata even when the origin matches", () => {
    expect(() => requireSameOrigin(request({ origin: "https://vpn.example.com", "sec-fetch-site": "cross-site" }), "https://vpn.example.com")).toThrowError("Cross-site requests are not allowed");
  });

  it("parses cookie values without treating embedded equals signs as separators", () => {
    const cookies = parseCookies(request({ cookie: "session=abc==; csrf=token; malformed" }));
    expect(cookies.get("session")).toBe("abc==");
    expect(cookies.get("csrf")).toBe("token");
    expect(cookies.has("malformed")).toBe(false);
  });

  it("requires an exact sufficiently long CSRF header", () => {
    const token = "a".repeat(48);
    expect(() => requireCsrf(request({ "x-csrf-token": token }), token)).not.toThrow();
    expect(() => requireCsrf(request({ "x-csrf-token": "b".repeat(48) }), token)).toThrowError("CSRF validation failed");
  });

  it("parses JSON only for the JSON media type and enforces its byte limit", async () => {
    await expect(readJson(bodyRequest('{"ok":true}'))).resolves.toEqual({ ok: true });
    await expect(readJson(bodyRequest("{}", "text/plain"))).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
    await expect(readJson(bodyRequest('{"large":true}'), 4)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    await expect(readJson(bodyRequest("{"))).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });
});
