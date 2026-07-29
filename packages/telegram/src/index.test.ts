import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTelegramInitData } from "./index.js";

function signedData(token: string, authDate: number): string {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "q1", user: '{"id":42}' });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

describe("Telegram Mini App validation", () => {
  it("accepts fresh authentic init data", () => {
    const token = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI";
    const now = new Date("2026-07-29T04:45:00Z");
    const data = signedData(token, Math.floor(now.getTime() / 1000));
    expect(verifyTelegramInitData(data, token, now).queryId).toBe("q1");
  });

  it("rejects tampering", () => {
    const token = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI";
    const now = new Date("2026-07-29T04:45:00Z");
    expect(() => verifyTelegramInitData(`${signedData(token, Math.floor(now.getTime() / 1000))}&x=1`, token, now)).toThrow();
  });
});
