import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, setCsrf, uploadReceipt } from "./api.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setCsrf("");
});

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Mini App API client", () => {
  it("uses same-origin credentials and does not send CSRF for GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await expect(api<{ ok: boolean }>("/plans")).resolves.toEqual({ ok: true });
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(options?.credentials).toBe("same-origin");
    expect(new Headers(options?.headers).has("x-csrf-token")).toBe(false);
  });

  it("sends JSON and the in-memory CSRF token for mutations", async () => {
    setCsrf("secure-csrf-token");
    fetchMock.mockResolvedValue(jsonResponse({ id: "order-1" }));
    await api("/orders", { method: "POST", body: JSON.stringify({ planId: "plan-1" }) });
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(url).toBe("/api/v1/orders");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-csrf-token")).toBe("secure-csrf-token");
  });

  it("surfaces sanitized JSON API errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Order mode is disabled" }, 403));
    await expect(api("/orders", { method: "POST", body: "{}" })).rejects.toThrow("Order mode is disabled");
  });

  it("uploads receipt bytes with explicit media type and filename", async () => {
    setCsrf("secure-csrf-token");
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const file = new File([new Uint8Array([1, 2, 3])], "receipt.png", { type: "image/png" });
    await uploadReceipt("order-1", file);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(url).toBe("/api/v1/orders/order-1/receipt");
    expect(options?.body).toBe(file);
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("x-receipt-file-name")).toBe("receipt.png");
    expect(headers.get("x-csrf-token")).toBe("secure-csrf-token");
  });
});
