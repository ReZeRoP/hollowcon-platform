export interface Me {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  locale: "fa" | "en";
  role: "owner" | "admin" | "finance" | "support" | "server_operator" | "marketing" | "auditor" | null;
  csrfToken: string;
}

export interface Plan {
  id: string;
  nameFa: string;
  nameEn: string;
  priceRial: string;
  durationDays: number;
  trafficBytes: string;
  deviceLimit: number;
  protocol: string;
  active?: boolean;
  inboundIds?: string[];
}

export interface Order {
  id: string;
  status: string;
  planNameFa: string;
  planNameEn: string;
  payableAmountRial: string;
  recipientCardMasked: string;
  reservationExpires: string;
}

export interface Subscription {
  id: string;
  status: string;
  expiresAt: string;
  trafficBytes: string;
  trafficUsedBytes: string;
  provisionedAt: string | null;
  deliveredAt: string | null;
  configsAvailable: boolean;
}

let csrfToken = readCookie("hollowcon_csrf");

export function setCsrf(value: string): void {
  csrfToken = value;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof Blob) && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.method && options.method !== "GET") headers.set("x-csrf-token", csrfToken || readCookie("hollowcon_csrf"));
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: "same-origin" });
  const type = response.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? await response.json() as unknown : await response.blob();
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "message" in data ? String(data.message) : "Request failed";
    throw new Error(message);
  }
  return data as T;
}

export async function uploadReceipt(orderId: string, file: File): Promise<void> {
  await api(`/orders/${orderId}/receipt`, {
    method: "POST",
    body: file,
    headers: { "content-type": file.type, "x-receipt-file-name": file.name },
  });
}

function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}
