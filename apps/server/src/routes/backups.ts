import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth.js";
import { EVERY_HOURS_CHOICES } from "../backup.js";
import { parse } from "../validate.js";

const ConfigBody = z.object({
  enabled: z.boolean(),
  everyHours: z.number().int().refine((n) => (EVERY_HOURS_CHOICES as readonly number[]).includes(n), "Choose how often from the list."),
  keep: z.number().int().min(1, "Keep at least one backup.").max(90, "Keep 90 backups or fewer."),
  includeGalleries: z.boolean(),
  includeOriginals: z.boolean(),
});

/** Backups: settings, the list, download, delete and run-now. Owner only. */
export async function backupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOwner);
  const svc = () => app.ctx.backups;

  app.get("/", async () => ({ config: svc().config(), files: svc().list(), status: svc().status(), everyHoursChoices: EVERY_HOURS_CHOICES }));

  app.get("/sizes", async () => svc().sizes());

  app.put("/config", async (req, reply) => {
    const body = parse(ConfigBody, req.body, reply);
    if (!body) return;
    svc().saveConfig(body);
    return { config: svc().config() };
  });

  app.post("/run", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (_req, reply) => {
    if (svc().status().running) return reply.code(409).send({ error: "busy", message: "A backup is already running." });
    // Runs in the background: big photo backups take minutes. The page polls the list for the result.
    void svc().run("manual").catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "manual backup failed"));
    return reply.code(202).send({ started: true });
  });

  app.get("/files/:name", async (req, reply) => {
    const file = svc().pathOf((req.params as { name: string }).name);
    if (!file) return reply.code(404).send({ error: "not_found", message: "That backup no longer exists." });
    const name = (req.params as { name: string }).name;
    return reply
      .header("content-type", name.endsWith(".zip") ? "application/zip" : "application/octet-stream")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("content-length", fs.statSync(file).size)
      .header("cache-control", "no-store")
      .send(fs.createReadStream(file));
  });

  app.delete("/files/:name", async (req, reply) => {
    if (!svc().remove((req.params as { name: string }).name)) return reply.code(404).send({ error: "not_found", message: "That backup no longer exists." });
    return { ok: true };
  });
}
