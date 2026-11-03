import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth.js";
import { logFiles, readLog } from "../logs.js";
import { parse } from "../validate.js";

const Query = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** The app's own log, for the owner. Private links are already masked in the file. */
export async function logRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOwner);
  const dir = () => app.ctx.config.configDir + "/logs";

  app.get("/", async (req, reply) => {
    const q = parse(Query, req.query, reply);
    if (!q) return;
    return { ...readLog(dir(), q), at: Date.now() };
  });

  app.get("/download", async (_req, reply) => {
    const files = logFiles(dir());
    const text = files.map((f) => fs.readFileSync(f, "utf8")).join("");
    return reply.header("content-type", "text/plain; charset=utf-8").header("content-disposition", 'attachment; filename="openportrait-log.txt"').header("cache-control", "no-store").send(text);
  });
}
