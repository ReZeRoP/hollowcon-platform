import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { IncomingMessage } from "node:http";

import { ApiError } from "./http.js";

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export interface StoredReceipt {
  readonly storageKey: string;
  readonly storagePath: string;
  readonly detectedMediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly originalFileName?: string;
}

export async function storeReceipt(
  request: IncomingMessage,
  storageRoot: string,
  maximumBytes: number,
): Promise<StoredReceipt> {
  const suppliedMediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (!suppliedMediaType || !MEDIA_TYPES.has(suppliedMediaType)) {
    throw new ApiError(415, "unsupported_media_type", "Receipt must be JPEG, PNG, WebP, or PDF");
  }

  const originalFileName = safeFileName(request.headers["x-receipt-file-name"]);
  const chunks: Buffer[] = [];
  let byteSize = 0;
  const hash = createHash("sha256");
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    byteSize += buffer.length;
    if (byteSize > maximumBytes) {
      throw new ApiError(413, "receipt_too_large", "Receipt exceeds the allowed file size");
    }
    hash.update(buffer);
    chunks.push(buffer);
  }
  if (byteSize < 1_024) {
    throw new ApiError(400, "receipt_too_small", "Receipt file is too small");
  }

  const content = Buffer.concat(chunks);
  const detectedMediaType = sniffMediaType(content);
  if (!detectedMediaType || detectedMediaType !== suppliedMediaType) {
    throw new ApiError(415, "receipt_type_mismatch", "Receipt content does not match its declared media type");
  }

  const storageKey = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extensionFor(detectedMediaType)}`;
  const temporaryPath = join(storageRoot, ".tmp", `${randomUUID()}.upload`);
  const storagePath = resolveStoragePath(storageRoot, storageKey);
  await mkdir(join(storageRoot, ".tmp"), { recursive: true, mode: 0o700 });
  await mkdir(join(storageRoot, storageKey.split("/")[0] ?? "receipts"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, storagePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    storageKey,
    storagePath,
    detectedMediaType,
    byteSize,
    sha256: hash.digest("hex"),
    ...(originalFileName ? { originalFileName } : {}),
  };
}

export async function removeStoredReceipt(storagePath: string): Promise<void> {
  await rm(storagePath, { force: true });
}

export function resolveStoragePath(storageRoot: string, storageKey: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\/[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/u.test(storageKey)) {
    throw new ApiError(400, "invalid_storage_key", "Invalid receipt storage key");
  }
  const root = resolve(storageRoot);
  const path = resolve(root, storageKey);
  if (relative(root, path).startsWith("..")) {
    throw new ApiError(400, "invalid_storage_key", "Invalid receipt storage key");
  }
  return path;
}

function sniffMediaType(content: Buffer): string | undefined {
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return undefined;
}

function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "application/pdf": return "pdf";
    default: throw new ApiError(415, "unsupported_media_type", "Unsupported receipt media type");
  }
}

function safeFileName(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = [...basename(value)]
    .map((character) => (character.codePointAt(0) ?? 0) < 32 ? "_" : character)
    .join("")
    .replace(/[<>:"|?*]/gu, "_")
    .trim();
  return normalized.length > 0 && normalized.length <= 160 ? normalized : undefined;
}
