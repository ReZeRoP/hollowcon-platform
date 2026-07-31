import { describe, expect, it } from "vitest";
import { ThreeXUiClient, ThreeXUiError } from "./index.js";

describe("3x-ui v3.5.0 adapter", () => {
  it("uses Bearer auth and the documented inbound options endpoint", async () => {
    let request: Request | undefined;
    const client = new ThreeXUiClient({ baseUrl: "https://panel.example.com/base/", apiToken: "secret", fetch: (input, init) => { request = new Request(input, init); return Promise.resolve(Response.json({ success: true, msg: "", obj: [{ id: 1, remark: "Iran", tag: "in-1", protocol: "vless", port: 443, tlsFlowCapable: true, ssMethod: "" }] })); } });
    const options = await client.listInboundOptions();
    expect(options[0]?.protocol).toBe("vless");
    expect(request?.url).toBe("https://panel.example.com/base/panel/api/inbounds/options");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
  });

  it("accepts optional v3.5.0 client fields", async () => {
    const client = new ThreeXUiClient({
      baseUrl: "https://panel.example.com/base/",
      apiToken: "secret",
      fetch: () => Promise.resolve(Response.json({ success: true, obj: { email: "hc-order@example.invalid" } })),
    });
    const found = await client.getClient("hc-order@example.invalid");
    expect(found).toMatchObject({ email: "hc-order@example.invalid", enable: true });
    expect(found.subId).toBeUndefined();
  });

  it("rejects unsafe numeric mutation values before sending a request", async () => {
    let called = false;
    const client = new ThreeXUiClient({
      baseUrl: "https://panel.example.com/",
      apiToken: "secret",
      fetch: () => {
        called = true;
        return Promise.resolve(Response.json({ success: true, obj: null }));
      },
    });
    await expect(client.createClient({ email: "x@example.invalid", inboundIds: [1], expiryTime: Date.now(), totalGB: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("totalGB");
    expect(called).toBe(false);
  });

  it("classifies incompatible response payloads without exposing credentials", async () => {
    const client = new ThreeXUiClient({
      baseUrl: "https://panel.example.com/",
      apiToken: "top-secret-token",
      fetch: () => Promise.resolve(Response.json({ success: true, obj: { unexpected: true } })),
    });
    const error = await client.getClient("missing@example.invalid").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ThreeXUiError);
    expect(String(error)).not.toContain("top-secret-token");
  });

  it("refuses insecure panel URLs", () => {
    expect(() => new ThreeXUiClient({ baseUrl: "http://panel.example.com", apiToken: "secret" })).toThrow();
  });
});
