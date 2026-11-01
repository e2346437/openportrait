import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { allAutomations } from "../automation/registry.js";
import { automationStatus } from "../automation/queue.js";
import { requireOwner } from "../auth.js";
import { parse } from "../validate.js";

const Body = z.object({
  mode: z.enum(["built-in", "ai"]).optional(),
  /** An owner for one automation, or null to follow the mode again. */
  overrides: z.record(z.string(), z.enum(["built-in", "ai", "off"]).nullable()).optional(),
  windowHours: z.number().int().min(1).max(168).optional(),
});

export async function automationRoutes(app: FastifyInstance) {
  const { settings, db } = app.ctx;

  app.get("/", { preHandler: requireOwner }, async () => automationStatus(app.ctx));

  app.put("/", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(Body, req.body, reply);
    if (!body) return;
    const known = new Set(allAutomations().map((a) => a.id));
    if (body.overrides && Object.keys(body.overrides).some((id) => !known.has(id))) return reply.code(400).send({ error: "invalid", message: "Unknown automation." });
    if (body.mode) settings.set("automation.mode", body.mode);
    if (body.windowHours) settings.set("automation.aiCheckinWindowHours", body.windowHours);
    if (body.overrides) {
      const next = { ...(settings.get("automation.overrides") ?? {}) };
      for (const [id, owner] of Object.entries(body.overrides)) {
        if (owner === null) delete next[id];
        else next[id] = owner;
      }
      settings.set("automation.overrides", next);
    }
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "automation.settings", detail: body, ip: app.ctx.ip(req) }).run();
    return automationStatus(app.ctx);
  });
}
