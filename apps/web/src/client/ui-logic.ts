export type Locale = "fa" | "en";
export type Screen =
  | "plans"
  | "orders"
  | "services"
  | "reviews"
  | "system"
  | "operators"
  | "audit";

export type OperatorRole =
  | "owner"
  | "admin"
  | "finance"
  | "support"
  | "server_operator"
  | "marketing"
  | "auditor"
  | null;

export interface TelegramBootstrap {
  readonly initData: string;
  ready(): void;
  expand(): void;
}

export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function initializeTelegramWebApp(
  webApp: TelegramBootstrap | undefined,
): string | null {
  if (!webApp?.initData) return null;
  webApp.ready();
  webApp.expand();
  return webApp.initData;
}

export function documentLanguage(locale: Locale): {
  readonly lang: Locale;
  readonly dir: "rtl" | "ltr";
} {
  return { lang: locale, dir: locale === "fa" ? "rtl" : "ltr" };
}

export function visibleScreens(role: OperatorRole): Screen[] {
  const screens: Screen[] = ["plans", "orders", "services"];
  if (role === "owner" || role === "admin" || role === "finance") {
    screens.push("reviews");
  }
  if (
    role === "owner" ||
    role === "admin" ||
    role === "server_operator" ||
    role === "auditor"
  ) {
    screens.push("system");
  }
  if (role === "owner") screens.push("operators");
  if (role !== null) screens.push("audit");
  return screens;
}

export function orderIdempotencyKey(
  planId: string,
  storage: KeyStorage,
  createUuid: () => string,
): string {
  const storageKey = `order:${planId}`;
  const existing = storage.getItem(storageKey);
  if (existing) return existing;
  const created = `web:${createUuid()}`;
  storage.setItem(storageKey, created);
  return created;
}

export function isAcceptedReceiptFile(file: Pick<File, "type" | "size">): boolean {
  const mediaTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]);
  return mediaTypes.has(file.type) && file.size >= 1_024 && file.size <= 8_388_608;
}
