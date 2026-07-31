import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { PrismaClient } from "@prisma/client";
import { loadConfig } from "@hollowcon/config";

import { safeWorkerError } from "./logic.js";
import { WorkerProcessor } from "./processor.js";

const config = loadConfig();
const port = Number.parseInt(process.env["WORKER_HEALTH_PORT"] ?? "3003", 10);
const prisma = new PrismaClient();
const workerId = `worker:${randomUUID()}`;
const processor = new WorkerProcessor({ config, prisma, workerId });
let databaseReady = false;
let processorReady = false;
let processing = false;

async function checkDatabase(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseReady = true;
  } catch {
    databaseReady = false;
  }
}

async function poll(): Promise<void> {
  if (processing || !databaseReady) return;
  processing = true;
  try {
    await processor.recoverExpiredLeases();
    const event = await processor.provisioningEnabled()
      ? await processor.claimEvent()
      : null;
    if (event) await processor.processEvent(event.id, event.eventType, event.payload);
    processorReady = true;
  } catch (error) {
    processorReady = false;
    console.error(JSON.stringify({
      level: "error",
      service: "worker",
      event: "poll.failed",
      error: safeWorkerError(error),
    }));
  } finally {
    processing = false;
  }
}

const databaseInterval = setInterval(() => void checkDatabase(), 10_000);
const workInterval = setInterval(() => void poll(), config.WORKER_POLL_INTERVAL_MS);
void checkDatabase().then(poll);

const server = createServer((_request, response) => {
  const status = databaseReady && processorReady ? 200 : 503;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({
    status: status === 200 ? "ready" : "starting",
    service: "worker",
    processorReady,
  }));
});

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({
    level: "info",
    service: "worker",
    event: "listening",
    port,
    workerId,
  }));
});

async function shutdown(): Promise<void> {
  clearInterval(databaseInterval);
  clearInterval(workInterval);
  server.close();
  await prisma.$disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
