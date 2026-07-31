import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebServer } from "./app.js";

let root = "";
let baseUrl = "";
let server: ReturnType<typeof createWebServer>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hollowcon-web-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main>Hollowcon</main>");
  await writeFile(join(root, "assets", "app-abcdefgh.js"), "console.log('ok')");
  server = createWebServer(root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("web static server", () => {
  it("serves readiness without caching", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: "web" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves SPA routes with security headers", async () => {
    const response = await fetch(`${baseUrl}/services/active`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hollowcon");
    expect(response.headers.get("content-security-policy")).toContain("https://telegram.org");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("uses immutable caching only for hashed assets", async () => {
    const response = await fetch(`${baseUrl}/assets/app-abcdefgh.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("does not return index HTML for missing assets", async () => {
    const response = await fetch(`${baseUrl}/assets/missing.js`);
    expect(response.status).toBe(404);
  });

  it("rejects unsupported methods and malformed URL encoding", async () => {
    expect((await fetch(`${baseUrl}/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/%E0%A4%A`)).status).toBe(400);
  });
});
