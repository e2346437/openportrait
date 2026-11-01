import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { count } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { createSession, hashPassword, setSessionCookie } from "../auth.js";
import { email, parse, password, timezone } from "../validate.js";

const SetupBody = z.object({
  studioName: z.string().trim().min(1, "Enter your studio's name.").max(120),
  ownerName: z.string().trim().min(1, "Enter your name.").max(120),
  email,
  password,
  timezone,
});

export async function setupRoutes(app: FastifyInstance) {
  const { db, settings, config } = app.ctx;
  const needsSetup = () => (db.select({ n: count() }).from(tables.user).get()?.n ?? 0) === 0;

  app.get("/", async () => ({
    needsSetup: needsSetup(),
    platform: config.isUnraid ? "unraid" : "docker",
    suggestedTimezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  app.post("/", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(SetupBody, req.body, reply);
    if (!body) return;
    const passwordHash = await hashPassword(body.password);
    const userId = crypto.randomUUID();
    const created = db.transaction((tx) => {
      // Re-check inside the transaction so two browsers can't both create an owner.
      if ((tx.select({ n: count() }).from(tables.user).get()?.n ?? 0) > 0) return false;
      tx.insert(tables.user).values({ id: userId, email: body.email, name: body.ownerName, passwordHash, role: "owner" }).run();
      tx.insert(tables.auditLog).values({ userId, action: "setup.completed", ip: app.ctx.ip(req) }).run();
      return true;
    });
    if (!created) return reply.code(409).send({ error: "already_set_up", message: "This studio is already set up. Sign in instead." });
    settings.set("studio.name", body.studioName);
    settings.set("studio.email", body.email);
    settings.set("studio.timezone", body.timezone);
    settings.set("setup.completedAt", Date.now());
    const { token, expiresAt } = createSession(db, userId, { ip: app.ctx.ip(req), userAgent: req.headers["user-agent"] });
    setSessionCookie(reply, token, expiresAt, req.protocol === "https" || !!req.headers["cf-ray"]);
    return { user: { id: userId, email: body.email, name: body.ownerName, role: "owner" } };
  });
}
