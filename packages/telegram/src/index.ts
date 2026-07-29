import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramInitData {
  readonly authDate: Date;
  readonly queryId?: string;
  readonly user?: unknown;
  readonly raw: URLSearchParams;
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  now = new Date(),
  maxAgeSeconds = 300,
): TelegramInitData {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) throw new Error("Missing or invalid Telegram hash");

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const received = Buffer.from(receivedHash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Invalid Telegram signature");

  const authDateSeconds = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDateSeconds)) throw new Error("Invalid Telegram auth_date");
  const age = Math.floor(now.getTime() / 1000) - authDateSeconds;
  if (age < 0 || age > maxAgeSeconds) throw new Error("Expired Telegram init data");

  const queryId = params.get("query_id");
  const userValue = params.get("user");
  return {
    authDate: new Date(authDateSeconds * 1000),
    ...(queryId !== null ? { queryId } : {}),
    ...(userValue ? { user: JSON.parse(userValue) as unknown } : {}),
    raw: params,
  };
}
