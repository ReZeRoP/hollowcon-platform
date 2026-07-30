import { describe, expect, it } from "vitest";

import {
  createOrderRequestSchema,
  rialStringSchema,
  setupCardSchema,
  setupPanelSchema,
} from "./index.js";

describe("shared API contracts", () => {
  it("keeps rial values lossless as decimal strings", () => {
    expect(rialStringSchema.parse("9007199254740993000")).toBe("9007199254740993000");
    expect(() => rialStringSchema.parse("12.5")).toThrow();
  });

  it("normalizes card input and requires HTTPS panels", () => {
    expect(setupCardSchema.parse({ pan: "6037-9912-3456-7890", cardholderName: "Zero" }).pan).toBe(
      "6037991234567890",
    );
    expect(() => setupPanelSchema.parse({ name: "Panel", baseUrl: "http://panel.test", apiToken: "x".repeat(20) })).toThrow();
  });

  it("requires explicit order idempotency", () => {
    expect(createOrderRequestSchema.parse({ planId: "plan_12345678", idempotencyKey: "order:telegram:123456" })).toMatchObject({
      planId: "plan_12345678",
    });
  });
});
