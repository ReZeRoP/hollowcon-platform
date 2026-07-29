import { describe, expect, it } from "vitest";
import { ThreeXUiClient } from "./index.js";

describe("3x-ui v3.5.0 adapter", () => {
  it("uses Bearer auth and the documented inbound options endpoint", async () => {
    let request: Request | undefined;
    const client = new ThreeXUiClient({ baseUrl: "https://panel.example.com/base/", apiToken: "secret", fetch: (input, init) => { request = new Request(input, init); return Promise.resolve(Response.json({ success: true, msg: "", obj: [{ id: 1, remark: "Iran", tag: "in-1", protocol: "vless", port: 443, tlsFlowCapable: true, ssMethod: "" }] })); } });
    const options = await client.listInboundOptions();
    expect(options[0]?.protocol).toBe("vless");
    expect(request?.url).toBe("https://panel.example.com/base/panel/api/inbounds/options");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
  });

  it("refuses insecure panel URLs", () => {
    expect(() => new ThreeXUiClient({ baseUrl: "http://panel.example.com", apiToken: "secret" })).toThrow();
  });
});
