import { describe, expect, it, vi } from "vitest";

import {
  documentLanguage,
  initializeTelegramWebApp,
  isAcceptedReceiptFile,
  orderIdempotencyKey,
  visibleScreens,
} from "./ui-logic.js";

describe("Mini App browser behavior", () => {
  it("boots only from Telegram initData and signals readiness", () => {
    const ready = vi.fn();
    const expand = vi.fn();
    expect(initializeTelegramWebApp(undefined)).toBeNull();
    expect(initializeTelegramWebApp({ initData: "", ready, expand })).toBeNull();
    expect(initializeTelegramWebApp({ initData: "signed-init-data", ready, expand })).toBe("signed-init-data");
    expect(ready).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });

  it("maps Persian to RTL and English to LTR", () => {
    expect(documentLanguage("fa")).toEqual({ lang: "fa", dir: "rtl" });
    expect(documentLanguage("en")).toEqual({ lang: "en", dir: "ltr" });
  });

  it("exposes staff screens strictly by role", () => {
    expect(visibleScreens(null)).toEqual(["plans", "orders", "services"]);
    expect(visibleScreens("finance")).toEqual(["plans", "orders", "services", "reviews", "audit"]);
    expect(visibleScreens("server_operator")).toEqual(["plans", "orders", "services", "system", "audit"]);
    expect(visibleScreens("owner")).toEqual(["plans", "orders", "services", "reviews", "system", "operators", "audit"]);
    expect(visibleScreens("marketing")).toEqual(["plans", "orders", "services", "audit"]);
  });

  it("reuses the same per-plan order idempotency key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const createUuid = vi.fn(() => "uuid-1");
    expect(orderIdempotencyKey("plan-1", storage, createUuid)).toBe("web:uuid-1");
    expect(orderIdempotencyKey("plan-1", storage, createUuid)).toBe("web:uuid-1");
    expect(createUuid).toHaveBeenCalledOnce();
  });

  it("accepts only supported receipt media within the configured size boundary", () => {
    expect(isAcceptedReceiptFile({ type: "image/png", size: 1_024 })).toBe(true);
    expect(isAcceptedReceiptFile({ type: "application/pdf", size: 8_388_608 })).toBe(true);
    expect(isAcceptedReceiptFile({ type: "text/plain", size: 4_096 })).toBe(false);
    expect(isAcceptedReceiptFile({ type: "image/jpeg", size: 1_023 })).toBe(false);
    expect(isAcceptedReceiptFile({ type: "image/webp", size: 8_388_609 })).toBe(false);
  });
});
