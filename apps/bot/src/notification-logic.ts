export function parseDeliveryPayload(value: unknown): { subscriptionId: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const subscriptionId = (value as Record<string, unknown>)["subscriptionId"];
  return typeof subscriptionId === "string" && subscriptionId.length > 0 ? { subscriptionId } : null;
}

export function parseLinks(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((link) => typeof link === "string" && link.length > 0)) return [];
    return parsed as string[];
  } catch {
    return [];
  }
}

export function parseMessageIds(value: unknown): number[] {
  return Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0) ? value as number[] : [];
}

export function notificationFailure(attempts: number, maximumAttempts: number, retryable: boolean, now = new Date()):
  | { status: "manual_review"; lastErrorOnly: true }
  | { status: "failed"; availableAt: Date; lastErrorOnly: false } {
  if (!retryable || attempts >= maximumAttempts) return { status: "manual_review", lastErrorOnly: true };
  const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(attempts, 10));
  return { status: "failed", availableAt: new Date(now.getTime() + delay), lastErrorOnly: false };
}

export function safeTelegramError(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 80) : "telegram_delivery_failed";
}
