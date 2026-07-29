import { describe, expect, it } from "vitest";
import { can, payableAmount, rial, transitionOrder } from "./index.js";

describe("card-to-card pricing", () => {
  it("adds a collision-resistant review suffix in rials", () => {
    expect(payableAmount(rial(1_000_000), 347)).toBe(1_000_347);
  });

  it("rejects invalid suffixes", () => {
    expect(() => payableAmount(rial(1_000_000), 0)).toThrow();
  });
});

describe("order state machine", () => {
  it("allows the receipt review path", () => {
    expect(transitionOrder("awaiting_receipt", "under_review")).toBe("under_review");
  });

  it("prevents approving an order without review", () => {
    expect(() => transitionOrder("awaiting_receipt", "approved")).toThrow();
  });
});

describe("role permissions", () => {
  it("allows finance to review receipts but not panels", () => {
    expect(can("finance", "payments.review")).toBe(true);
    expect(can("finance", "panels.manage")).toBe(false);
  });
});
