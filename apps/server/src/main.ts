import { loadConfig } from "@openportrait/config";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp({ config });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: config.host });
app.log.info(`OpenPortrait is running on port ${config.port}`);
