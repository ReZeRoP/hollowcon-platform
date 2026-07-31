import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { resolveStoragePath, storeReceipt } from "./receipts.js";

const roots: string[] = [];

function upload(content: Buffer, mediaType: string, fileName?: string): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, {
    headers: {
      "content-type": mediaType,
      ...(fileName ? { "x-receipt-file-name": fileName } : {}),
    },
  });
  stream.end(content);
  return stream as unknown as IncomingMessage;
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hollowcon-receipts-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("private receipt storage", () => {
  it("stores a valid PNG under a randomized private path", async () => {
    const storageRoot = await root();
    const content = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1_200, 7)]);
    const stored = await storeReceipt(upload(content, "image/png", "../../bank:receipt?.png"), storageRoot, 5_000);

    expect(stored.detectedMediaType).toBe("image/png");
    expect(stored.originalFileName).toBe("bank_receipt_.png");
    expect(stored.storageKey).toMatch(/^\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.png$/u);
    expect(await readFile(stored.storagePath)).toEqual(content);
    expect((await stat(stored.storagePath)).isFile()).toBe(true);
  });

  it("rejects a declared type that disagrees with magic bytes", async () => {
    const storageRoot = await root();
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1_200)]);
    await expect(storeReceipt(upload(pdf, "image/png"), storageRoot, 5_000)).rejects.toMatchObject({ status: 415, code: "receipt_type_mismatch" });
  });

  it("rejects undersized and oversized receipt bodies", async () => {
    const storageRoot = await root();
    const tinyPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    const largePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2_000)]);
    await expect(storeReceipt(upload(tinyPng, "image/png"), storageRoot, 5_000)).rejects.toMatchObject({ status: 400, code: "receipt_too_small" });
    await expect(storeReceipt(upload(largePng, "image/png"), storageRoot, 1_024)).rejects.toMatchObject({ status: 413, code: "receipt_too_large" });
  });

  it("rejects unsupported media types and traversal storage keys", async () => {
    const storageRoot = await root();
    await expect(storeReceipt(upload(Buffer.alloc(1_200), "image/svg+xml"), storageRoot, 5_000)).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
    expect(() => resolveStoragePath(storageRoot, "../../etc/passwd")).toThrowError("Invalid receipt storage key");
    expect(() => resolveStoragePath(storageRoot, "2026-07-31/not-a-uuid.pdf")).toThrowError("Invalid receipt storage key");
  });
});
