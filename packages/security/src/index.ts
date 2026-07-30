import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const CIPHER = "aes-256-gcm";
const FORMAT_VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/u;

export type SecretPurpose = "panel-token" | "recipient-pan" | "session-token" | "subscription-links";

export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly keyId: string;
}

export interface EncryptSecretInput {
  readonly plaintext: string;
  readonly masterKey: string;
  readonly keyId?: string;
  readonly purpose: SecretPurpose;
  readonly context?: string;
}

export interface DecryptSecretInput extends Omit<EncryptSecretInput, "plaintext" | "keyId"> {
  readonly ciphertext: string;
  readonly expectedKeyId?: string;
}

export function encryptSecret(input: EncryptSecretInput): EncryptedSecret {
  if (input.plaintext.length === 0) {
    throw new Error("Secret plaintext cannot be empty");
  }
  const keyId = input.keyId ?? "primary";
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Invalid encryption key ID");
  }

  const key = deriveKey(input.masterKey, input.purpose);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAssociatedData(input.purpose, keyId, input.context));
  const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [FORMAT_VERSION, keyId, encode(nonce), encode(tag), encode(encrypted)].join("."),
    keyId,
  };
}

export function decryptSecret(input: DecryptSecretInput): string {
  const parts = input.ciphertext.split(".");
  if (parts.length !== 5) {
    throw new Error("Invalid encrypted secret format");
  }
  const [version, keyId, nonceValue, tagValue, ciphertextValue] = parts;
  if (version !== FORMAT_VERSION || !keyId || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Unsupported encrypted secret version");
  }
  if (input.expectedKeyId && !safeEqualText(input.expectedKeyId, keyId)) {
    throw new Error("Encrypted secret key ID mismatch");
  }

  const nonce = decode(nonceValue ?? "");
  const tag = decode(tagValue ?? "");
  const encrypted = decode(ciphertextValue ?? "");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || encrypted.length === 0) {
    throw new Error("Invalid encrypted secret payload");
  }

  try {
    const key = deriveKey(input.masterKey, input.purpose);
    const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAssociatedData(input.purpose, keyId, input.context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Encrypted secret authentication failed");
  }
}

export function generateOpaqueToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 128) {
    throw new RangeError("Opaque token size must be between 24 and 128 bytes");
  }
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(token: string, secret: string): string {
  if (token.length < 32) {
    throw new Error("Opaque token is too short");
  }
  const pepper = parseMasterKey(secret);
  return createHash("sha256").update(pepper).update("\0").update(token, "utf8").digest("hex");
}

export function maskIranianPan(pan: string): string {
  const normalized = pan.replace(/[\s-]/gu, "");
  if (!/^\d{16}$/u.test(normalized)) {
    throw new Error("Iranian card PAN must contain exactly 16 digits");
  }
  return `${normalized.slice(0, 6)}******${normalized.slice(-4)}`;
}

export function panLastFour(pan: string): string {
  const normalized = pan.replace(/[\s-]/gu, "");
  if (!/^\d{16}$/u.test(normalized)) {
    throw new Error("Iranian card PAN must contain exactly 16 digits");
  }
  return normalized.slice(-4);
}

function deriveKey(masterKey: string, purpose: SecretPurpose): Buffer {
  const material = parseMasterKey(masterKey);
  return Buffer.from(hkdfSync("sha256", material, Buffer.from("hollowcon:v1", "utf8"), Buffer.from(purpose, "utf8"), KEY_BYTES));
}

function parseMasterKey(masterKey: string): Buffer {
  const prefixed = /^(base64|hex):(.+)$/u.exec(masterKey);
  let material: Buffer;
  if (prefixed?.[1] === "base64") {
    material = Buffer.from(prefixed[2] ?? "", "base64");
  } else if (prefixed?.[1] === "hex") {
    material = Buffer.from(prefixed[2] ?? "", "hex");
  } else {
    material = Buffer.from(masterKey, "utf8");
  }
  if (material.length < KEY_BYTES) {
    throw new Error("Master key must contain at least 32 bytes");
  }
  return material;
}

function buildAssociatedData(purpose: SecretPurpose, keyId: string, context?: string): Buffer {
  return Buffer.from([FORMAT_VERSION, purpose, keyId, context ?? ""].join("\0"), "utf8");
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid encrypted secret encoding");
  }
  return Buffer.from(value, "base64url");
}

function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
