import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export function createWebServer(root: string): Server {
  const absoluteRoot = resolve(root);
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://web.internal").pathname);
    } catch {
      response.writeHead(400, { "cache-control": "no-store" }).end();
      return;
    }

    if (pathname === "/health/live" || pathname === "/health/ready") {
      const body = JSON.stringify({ status: "ok", service: "web" });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    const requested = pathname.replace(/^\/+/, "") || "index.html";
    const candidate = resolve(absoluteRoot, requested);
    const candidateRelative = relative(absoluteRoot, candidate);
    if (candidateRelative.startsWith(`..${sep}`) || candidateRelative === ".." || isAbsolute(candidateRelative)) {
      response.writeHead(400, { "cache-control": "no-store" }).end();
      return;
    }

    const candidateExists = existsSync(candidate) && statSync(candidate).isFile();
    const isAssetRequest = extname(pathname) !== "";
    const selected = candidateExists ? candidate : resolve(absoluteRoot, "index.html");
    if ((!candidateExists && isAssetRequest) || !existsSync(selected) || !statSync(selected).isFile()) {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }

    const extension = extname(selected);
    const assetsRoot = resolve(absoluteRoot, "assets");
    const selectedRelativeToAssets = relative(assetsRoot, selected);
    const insideAssets = selectedRelativeToAssets !== "" && !selectedRelativeToAssets.startsWith(`..${sep}`) && !isAbsolute(selectedRelativeToAssets);
    const immutable = insideAssets && /-[A-Za-z0-9_-]{8,}\./u.test(selected);
    response.writeHead(200, {
      "content-type": MIME[extension] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://telegram.org; img-src 'self' data: blob:; frame-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(selected).pipe(response);
  });
}
