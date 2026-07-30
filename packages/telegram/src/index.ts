import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramUser {
  readonly id: number;
  readonly isBot: boolean;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly languageCode?: string;
  readonly allowsWriteToPm?: boolean;
}

export interface TelegramInitData {
  readonly authDate: Date;
  readonly queryId?: string;
  readonly user?: TelegramUser;
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
    ...(userValue ? { user: parseTelegramUser(userValue) } : {}),
    raw: params,
  };
}

function parseTelegramUser(value: string): TelegramUser {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid Telegram user JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid Telegram user");
  }

  const id = parsed["id"];
  const firstName = parsed["first_name"];
  const isBot = parsed["is_bot"] ?? false;
  if (!Number.isSafeInteger(id) || typeof id !== "number" || id <= 0) {
    throw new Error("Invalid Telegram user ID");
  }
  if (typeof firstName !== "string" || firstName.length < 1 || firstName.length > 128) {
    throw new Error("Invalid Telegram first name");
  }
  if (typeof isBot !== "boolean" || isBot) {
    throw new Error("Telegram bot accounts cannot authenticate");
  }

  const lastName = optionalText(parsed["last_name"], "last name", 128);
  const username = optionalText(parsed["username"], "username", 64);
  const languageCode = optionalText(parsed["language_code"], "language code", 16);
  const allowsWriteToPm = parsed["allows_write_to_pm"];
  if (allowsWriteToPm !== undefined && typeof allowsWriteToPm !== "boolean") {
    throw new Error("Invalid Telegram write permission");
  }

  return {
    id,
    isBot,
    firstName,
    ...(lastName ? { lastName } : {}),
    ...(username ? { username } : {}),
    ...(languageCode ? { languageCode } : {}),
    ...(typeof allowsWriteToPm === "boolean" ? { allowsWriteToPm } : {}),
  };
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Invalid Telegram ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
