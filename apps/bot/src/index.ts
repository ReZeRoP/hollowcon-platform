import { createServer } from "node:http";

import { Bot } from "grammy";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const port = Number.parseInt(process.env["BOT_HEALTH_PORT"] ?? "3002", 10);
const bot = new Bot(token);
bot.command("start", async (context) => {
  await context.reply("هالوکان در حال آماده‌سازی است. Hollowcon is being prepared.");
});

const healthServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: "ok", service: "bot", mode: "long-polling" }));
});

healthServer.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "bot", event: "health-listening", port }));
});

void bot.start({
  onStart: () => console.info(JSON.stringify({ level: "info", service: "bot", event: "polling" })),
});

function shutdown(): void {
  void bot.stop();
  healthServer.close();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
