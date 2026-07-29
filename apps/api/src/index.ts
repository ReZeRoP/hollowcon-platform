import { createServer, type ServerResponse } from "node:http";

import { PrismaClient } from "@prisma/client";

const port = Number.parseInt(process.env["API_PORT"] ?? "3000", 10);
const prisma = new PrismaClient();
let ready = false;

const server = createServer((request, response) => {
  void handleRequest(request.url, response);
});

async function handleRequest(url: string | undefined, response: ServerResponse): Promise<void> {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");

  if (url === "/health/live") {
    response.writeHead(200).end(JSON.stringify({ status: "ok", service: "api" }));
    return;
  }
  if (url === "/health/ready") {
    try {
      await prisma.$queryRaw`SELECT 1`;
      ready = true;
      response.writeHead(200).end(JSON.stringify({ status: "ready", service: "api" }));
    } catch {
      ready = false;
      response.writeHead(503).end(JSON.stringify({ status: "unavailable", service: "api" }));
    }
    return;
  }

  response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
}

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "api", event: "listening", port }));
});

async function shutdown(signal: string): Promise<void> {
  ready = false;
  console.info(JSON.stringify({ level: "info", service: "api", event: "shutdown", signal }));
  server.close();
  await prisma.$disconnect();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

void ready;
