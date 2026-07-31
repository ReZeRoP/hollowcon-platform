import { join } from "node:path";

import { createWebServer } from "./app.js";

const port = Number.parseInt(process.env["WEB_PORT"] ?? "3001", 10);
const root = join(process.cwd(), "apps", "web", "dist");
const server = createWebServer(root);

server.listen(port, "0.0.0.0", () => console.info(JSON.stringify({ level: "info", service: "web", event: "listening", port })));
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
