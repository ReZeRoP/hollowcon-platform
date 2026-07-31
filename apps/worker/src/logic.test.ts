import { ThreeXUiError } from "@hollowcon/three-x-ui";
import { describe, expect, it } from "vitest";

import { deterministicClientEmail, isRetryable, ManualReviewError, parseProvisioningPayload, safeExternalInteger, safeWorkerError, selectInbound } from "./logic.js";

describe("worker provisioning logic", () => {
  it("parses only complete provisioning payloads", () => {
    expect(parseProvisioningPayload({ orderId: "order-1", provisioningJobId: "job-1" })).toEqual({ orderId: "order-1", provisioningJobId: "job-1" });
    expect(parseProvisioningPayload({ orderId: "order-1" })).toBeNull();
    expect(parseProvisioningPayload([])).toBeNull();
  });

  it("uses a deterministic remote client identity", () => {
    expect(deterministicClientEmail("cm123")).toBe("hc-cm123@hollowcon.invalid");
  });

  it("selects the lowest-utilization healthy eligible inbound", () => {
    const now = new Date("2026-07-31T00:00:00.000Z");
    const selected = selectInbound([
      { id: "full", enabled: true, activeClients: 10, capacity: 10, panel: { enabled: true, circuitOpenUntil: null } },
      { id: "open-circuit", enabled: true, activeClients: 0, capacity: 100, panel: { enabled: true, circuitOpenUntil: new Date("2026-08-01T00:00:00.000Z") } },
      { id: "busy", enabled: true, activeClients: 50, capacity: 100, panel: { enabled: true, circuitOpenUntil: null } },
      { id: "best", enabled: true, activeClients: 10, capacity: 100, panel: { enabled: true, circuitOpenUntil: null } },
    ], now);
    expect(selected?.id).toBe("best");
  });

  it("rejects values that cannot be represented safely by 3x-ui", () => {
    expect(safeExternalInteger(42n, "trafficBytes")).toBe(42);
    expect(() => safeExternalInteger(-1n, "trafficBytes")).toThrow(ManualReviewError);
    expect(() => safeExternalInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "trafficBytes")).toThrow(ManualReviewError);
  });

  it("classifies retryable and manual-review failures", () => {
    expect(isRetryable(new ThreeXUiError("timeout", 408))).toBe(true);
    expect(isRetryable(new ThreeXUiError("rate limit", 429))).toBe(true);
    expect(isRetryable(new ThreeXUiError("bad request", 400))).toBe(false);
    expect(isRetryable(new ManualReviewError("unsafe"))).toBe(false);
    expect(safeWorkerError(new ThreeXUiError("secret response", 500))).toBe("3x-ui:500");
    expect(safeWorkerError(new Error("secret"))).toBe("worker_operation_failed");
  });
});
