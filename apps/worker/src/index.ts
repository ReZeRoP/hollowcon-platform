import { createServer } from "node:http";

import { PrismaClient } from "@prisma/client";

const port = Number.parseInt(process.env["WORKER_HEALTH_PORT"] ?? "3003", 10);
const prisma = new PrismaClient();
let databaseReady = false;

async function checkDatabase(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseReady = true;
  } catch {
    databaseReady = false;
  }
}

const interval = setInterval(() => void checkDatabase(), 10_000);
void checkDatabase();

const server = createServer((_request, response) => {
  const status = databaseReady ? 200 : 503;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: databaseReady ? "ready" : "unavailable", service: "worker", provisioning: "not-enabled" }));
});

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "warn", service: "worker", event: "listening", port, provisioning: "not-enabled" }));
});

async function shutdown(): Promise<void> {
  clearInterval(interval);
  server.close();
  await prisma.$disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
