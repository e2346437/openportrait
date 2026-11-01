import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import { email, parse, timezone } from "../validate.js";

const StudioBody = z.object({
  name: z.string().trim().min(1, "Enter your studio's name.").max(120),
  email,
  timezone,
});

export async function settingsRoutes(app: FastifyInstance) {
  const { settings } = app.ctx;

  app.get("/studio", { preHandler: requireUser }, async () => ({
    name: settings.get("studio.name") ?? "",
    email: settings.get("studio.email") ?? "",
    timezone: settings.get("studio.timezone") ?? "UTC",
  }));

  app.put("/studio", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(StudioBody, req.body, reply);
    if (!body) return;
    settings.set("studio.name", body.name);
    settings.set("studio.email", body.email);
    settings.set("studio.timezone", body.timezone);
    return body;
  });
}
