import { z } from "zod";

const envelope = <T extends z.ZodType>(value: T) => z.object({ success: z.boolean(), msg: z.string().optional(), obj: value.optional() });
const inboundOption = z.object({ id: z.number().int(), remark: z.string(), tag: z.string(), protocol: z.string(), port: z.number().int(), tlsFlowCapable: z.boolean(), ssMethod: z.string() });
const client = z.object({ email: z.string(), enable: z.boolean(), expiryTime: z.number().int(), totalGB: z.number().int(), subId: z.string(), limitIp: z.number().int(), comment: z.string() }).passthrough();

export interface ThreeXUiOptions {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CreateClientInput {
  readonly email: string;
  readonly inboundIds: readonly number[];
  readonly expiryTime: number;
  readonly totalGB: number;
  readonly limitIp?: number;
  readonly telegramId?: number;
  readonly comment?: string;
}

export class ThreeXUiError extends Error {
  public constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ThreeXUiError";
  }
}

export type ThreeXUiFailureClass = "retryable" | "manual_review";

export function classifyThreeXUiFailure(error: unknown): ThreeXUiFailureClass {
  if (!(error instanceof ThreeXUiError)) return "retryable";
  if (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500) return "retryable";
  return "manual_review";
}

export class ThreeXUiClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(private readonly options: ThreeXUiOptions) {
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (this.baseUrl.protocol !== "https:") throw new Error("3x-ui panels must use HTTPS");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async health(): Promise<unknown> { return this.request("panel/api/server/status", "GET", z.unknown()); }
  async testConnection(): Promise<{ readonly health: unknown; readonly inbounds: z.infer<typeof inboundOption>[] }> {
    const [health, inbounds] = await Promise.all([this.health(), this.listInboundOptions()]);
    return { health, inbounds };
  }
  async listInboundOptions(): Promise<z.infer<typeof inboundOption>[]> { return this.request("panel/api/inbounds/options", "GET", z.array(inboundOption)); }
  async getClient(email: string): Promise<z.infer<typeof client>> { return this.request(`panel/api/clients/get/${encodeURIComponent(email)}`, "GET", client); }
  async createClient(input: CreateClientInput): Promise<unknown> {
    return this.request("panel/api/clients/add", "POST", z.unknown(), { client: { email: input.email, enable: true, expiryTime: input.expiryTime, totalGB: input.totalGB, limitIp: input.limitIp ?? 0, tgId: input.telegramId ?? 0, comment: input.comment ?? "hollowcon", reset: 0, security: "auto", subId: "" }, inboundIds: input.inboundIds });
  }
  async replaceClient(email: string, payload: Record<string, unknown>): Promise<unknown> { return this.request(`panel/api/clients/update/${encodeURIComponent(email)}`, "POST", z.unknown(), payload); }
  async deleteClient(email: string, keepTraffic = false): Promise<unknown> { return this.request(`panel/api/clients/del/${encodeURIComponent(email)}?keepTraffic=${keepTraffic ? "1" : "0"}`, "POST", z.unknown()); }
  async resetClientTraffic(email: string): Promise<unknown> { return this.request(`panel/api/clients/resetTraffic/${encodeURIComponent(email)}`, "POST", z.unknown()); }
  async clientTraffic(email: string): Promise<unknown> { return this.request(`panel/api/clients/traffic/${encodeURIComponent(email)}`, "GET", z.unknown()); }
  async clientLinks(email: string): Promise<string[]> { return this.request(`panel/api/clients/links/${encodeURIComponent(email)}`, "GET", z.array(z.string())); }

  private async request<T>(path: string, method: "GET" | "POST", schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers: { Authorization: `Bearer ${this.options.apiToken}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new ThreeXUiError(`3x-ui HTTP ${response.status}`, response.status);
    const parsed = envelope(z.unknown()).parse(await response.json());
    if (!parsed.success) throw new ThreeXUiError(parsed.msg ?? "3x-ui rejected the operation", response.status);
    return schema.parse(parsed.obj);
  }
}
