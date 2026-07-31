export type Brand<T, B extends string> = T & { readonly __brand: B };
export type Rial = Brand<number, "Rial">;

export function rial(value: number): Rial {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Rial amount must be a non-negative safe integer");
  }
  return value as Rial;
}

export function payableAmount(base: Rial, uniqueSuffix: number): Rial {
  if (!Number.isInteger(uniqueSuffix) || uniqueSuffix < 1 || uniqueSuffix > 999) {
    throw new RangeError("Unique suffix must be an integer from 1 to 999");
  }
  return rial(base + uniqueSuffix);
}

export const ORDER_TRANSITIONS = {
  draft: ["awaiting_receipt", "cancelled"],
  awaiting_receipt: ["under_review", "expired", "cancelled"],
  under_review: ["approved", "rejected"],
  rejected: ["awaiting_receipt", "cancelled"],
  approved: [],
  expired: [],
  cancelled: [],
} as const;

export type OrderState = keyof typeof ORDER_TRANSITIONS;
export type OrderEvent = (typeof ORDER_TRANSITIONS)[OrderState][number];

export function transitionOrder(current: OrderState, target: OrderState): OrderState {
  const allowed: readonly string[] = ORDER_TRANSITIONS[current];
  if (!allowed.includes(target)) {
    throw new Error(`Invalid order transition: ${current} -> ${target}`);
  }
  return target;
}

export const PROVISIONING_TRANSITIONS = {
  queued: ["running", "failed"],
  running: ["verifying", "failed"],
  verifying: ["provisioned", "failed", "manual_review"],
  failed: ["queued", "manual_review", "compensating"],
  compensating: ["failed", "manual_review"],
  manual_review: ["queued", "compensating"],
  provisioned: [],
  delivered: [],
} as const;

export type ProvisioningState = keyof typeof PROVISIONING_TRANSITIONS;

export type Role =
  | "owner"
  | "admin"
  | "finance"
  | "support"
  | "server_operator"
  | "marketing"
  | "auditor";

export type Permission =
  | "payments.review"
  | "panels.manage"
  | "users.manage"
  | "support.manage"
  | "broadcasts.manage"
  | "audit.read"
  | "settings.manage";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ["payments.review", "panels.manage", "users.manage", "support.manage", "broadcasts.manage", "audit.read", "settings.manage"],
  admin: ["payments.review", "panels.manage", "users.manage", "support.manage", "broadcasts.manage", "audit.read"],
  finance: ["payments.review", "audit.read"],
  support: ["users.manage", "support.manage"],
  server_operator: ["panels.manage", "audit.read"],
  marketing: ["broadcasts.manage"],
  auditor: ["audit.read"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
