import { requestIsHttps } from "../client-ip.js";
import crypto from "node:crypto";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
  setupCode: z.string().max(100).optional(),
});

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join("").replace(/(.{5})(.{5})/, "$1-$2");
const same = (a: string, b: string) => {
  const x = Buffer.from(a.trim().toUpperCase()), y = Buffer.from(b.trim().toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function setupRoutes(app: FastifyInstance) {
  const { db, settings, config } = app.ctx;
  const needsSetup = () => (db.select({ n: count() }).from(tables.user).get()?.n ?? 0) === 0;

  // A brand-new install must prove the caller can read the container's log or settings, so the first visitor to an
  // exposed port can't claim the studio (SEC-002). Not needed once an owner exists.
  let code: string | null = app.ctx.setupCode === undefined ? null : app.ctx.setupCode;
  if (app.ctx.setupCode === undefined && needsSetup()) {
    code = makeCode();
    app.log.warn(`First-run setup code: ${code}  (enter it on the setup page; it changes each time the container starts)`);
    // Also printed plainly so it is easy to find in the Unraid log viewer.
    console.warn(`\n==== OpenPortrait setup code: ${code} ====\n`);
  } else if (code && needsSetup()) {
    app.log.warn("First-run setup code comes from SETUP_CODE.");
  }

  app.get("/", async () => ({
    needsSetup: needsSetup(),
    setupCodeRequired: needsSetup() && !!code,
    platform: config.isUnraid ? "unraid" : "docker",
    suggestedTimezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  app.post("/", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(SetupBody, req.body, reply);
    if (!body) return;
    if (code && !same(body.setupCode ?? "", code)) {
      return reply.code(403).send({ error: "setup_code", field: "setupCode", message: "That setup code isn't right. You'll find it in the container's log." });
    }
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
    setSessionCookie(reply, token, expiresAt, requestIsHttps(req));
    return { user: { id: userId, email: body.email, name: body.ownerName, role: "owner" } };
  });
}

