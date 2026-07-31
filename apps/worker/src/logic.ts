import { ThreeXUiError } from "@hollowcon/three-x-ui";

export class ManualReviewError extends Error {}

export function parseProvisioningPayload(value: unknown): { orderId: string; provisioningJobId: string } | null {
  if (!isRecord(value)) return null;
  const orderId = value["orderId"];
  const provisioningJobId = value["provisioningJobId"];
  return typeof orderId === "string" && typeof provisioningJobId === "string" ? { orderId, provisioningJobId } : null;
}

export function parseOrderId(value: unknown): string | null {
  return parseProvisioningPayload(value)?.orderId ?? null;
}

export function selectInbound<T extends { enabled: boolean; panel: { enabled: boolean; circuitOpenUntil: Date | null }; activeClients: number; capacity: number | null }>(inbounds: readonly T[], now = new Date()): T | undefined {
  return inbounds
    .filter((inbound) => inbound.enabled && inbound.panel.enabled && (!inbound.panel.circuitOpenUntil || inbound.panel.circuitOpenUntil <= now))
    .filter((inbound) => inbound.capacity === null || inbound.activeClients < inbound.capacity)
    .sort((left, right) => utilization(left) - utilization(right))[0];
}

export function deterministicClientEmail(orderId: string): string {
  return `hc-${orderId}@hollowcon.invalid`;
}

export function safeExternalInteger(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new ManualReviewError(`${name} exceeds the 3x-ui safe integer range`);
  }
  return converted;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof ManualReviewError) return false;
  if (error instanceof ThreeXUiError) return error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
  return true;
}

export function safeWorkerError(error: unknown): string {
  if (error instanceof ManualReviewError) return error.message;
  if (error instanceof ThreeXUiError) return `3x-ui:${error.status ?? "network"}`;
  return "worker_operation_failed";
}

function utilization(inbound: { activeClients: number; capacity: number | null }): number {
  if (inbound.capacity === null) return inbound.activeClients / Number.MAX_SAFE_INTEGER;
  return inbound.activeClients / inbound.capacity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
