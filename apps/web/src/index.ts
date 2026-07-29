import { createServer } from "node:http";

const port = Number.parseInt(process.env["WEB_PORT"] ?? "3001", 10);
const page = `<!doctype html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hollowcon</title>
<style>body{margin:0;background:#0b1020;color:#eef2ff;font-family:Tahoma,Arial,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:680px;padding:40px;border:1px solid #293250;border-radius:20px;background:#111831}h1{color:#8b9cff}p{line-height:1.9}.tag{display:inline-block;background:#35235e;color:#dccbff;padding:7px 12px;border-radius:999px}</style></head>
<body><main><span class="tag">نسخه پیش‌انتشار / Pre-release</span><h1>Hollowcon</h1><p>زیرساخت سرویس فعال است. رابط کامل ربات، مینی‌اپ و مدیریت هنوز در حال توسعه است.</p><p dir="ltr">The service foundation is online. The complete bot, Mini App, and administration interface are still under development.</p></main></body></html>`;

const server = createServer((request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org");
  if (request.url === "/health/live" || request.url === "/health/ready") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: "web" }));
    return;
  }
  if (request.url === "/" || request.url === "/mini") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "web", event: "listening", port }));
});

process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
