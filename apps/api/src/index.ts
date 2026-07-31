import { PrismaClient } from "@prisma/client";
import { loadConfig } from "@hollowcon/config";
import { createClient } from "redis";

import { createApiServer } from "./app.js";

const config = loadConfig();
const port = Number.parseInt(process.env["API_PORT"] ?? "3000", 10);
const prisma = new PrismaClient();
const redis = createClient({ url: config.REDIS_URL });
redis.on("error", (error: unknown) =>
  console.error(
    JSON.stringify({
      level: "error",
      service: "api",
      event: "redis.error",
      error: error instanceof Error ? error.name : "RedisError",
    }),
  ),
);
void redis.connect().catch(() => undefined);

const server = createApiServer({ config, prisma, redis });
server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "api", event: "listening", port }));
});

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ level: "info", service: "api", event: "shutdown", signal }));
  server.close();
  if (redis.isOpen) await redis.quit();
  await prisma.$disconnect();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
