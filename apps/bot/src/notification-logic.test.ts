import { describe, expect, it } from "vitest";

import { notificationFailure, parseDeliveryPayload, parseLinks, parseMessageIds, safeTelegramError } from "./notification-logic.js";

describe("notification delivery logic", () => {
  it("validates local subscription payloads", () => {
    expect(parseDeliveryPayload({ subscriptionId: "subscription-1" })).toEqual({ subscriptionId: "subscription-1" });
    expect(parseDeliveryPayload({ subscriptionId: "" })).toBeNull();
    expect(parseDeliveryPayload({ orderId: "order-1" })).toBeNull();
  });

  it("accepts only non-empty string link arrays", () => {
    expect(parseLinks('["vless://one","trojan://two"]')).toEqual(["vless://one", "trojan://two"]);
    expect(parseLinks('["vless://one",2]')).toEqual([]);
    expect(parseLinks("not-json")).toEqual([]);
  });

  it("accepts only positive safe Telegram message IDs", () => {
    expect(parseMessageIds([1, 2, 3])).toEqual([1, 2, 3]);
    expect(parseMessageIds([0, 2])).toEqual([]);
    expect(parseMessageIds([Number.MAX_SAFE_INTEGER + 1])).toEqual([]);
  });

  it("uses exponential retry backoff and caps it at one hour", () => {
    const now = new Date("2026-07-31T00:00:00.000Z");
    expect(notificationFailure(1, 5, true, now)).toEqual({ status: "failed", availableAt: new Date("2026-07-31T00:00:02.000Z"), lastErrorOnly: false });
    expect(notificationFailure(20, 100, true, now)).toEqual({ status: "failed", availableAt: new Date("2026-07-31T00:17:04.000Z"), lastErrorOnly: false });
  });

  it("moves permanent and exhausted failures to manual review", () => {
    expect(notificationFailure(1, 5, false)).toEqual({ status: "manual_review", lastErrorOnly: true });
    expect(notificationFailure(5, 5, true)).toEqual({ status: "manual_review", lastErrorOnly: true });
  });

  it("redacts Telegram error details", () => {
    class TelegramNetworkError extends Error { public override readonly name = "TelegramNetworkError"; }
    expect(safeTelegramError(new TelegramNetworkError("contains token"))).toBe("TelegramNetworkError");
    expect(safeTelegramError("contains token")).toBe("telegram_delivery_failed");
  });
});
