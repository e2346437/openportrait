import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import {
  SESSION_COOKIE,
  burnPasswordCheck,
  createSession,
  destroySession,
  hashPassword,
  requireUser,
  setSessionCookie,
  verifyPassword,
} from "../auth.js";
import { parse, password } from "../validate.js";

const LoginBody = z.object({ email: z.string().trim().toLowerCase().min(1, "Enter your email."), password: z.string().min(1, "Enter your password.") });
const PasswordBody = z.object({ current: z.string().min(1, "Enter your current password."), next: password });

export async function authRoutes(app: FastifyInstance) {
  const { db, settings } = app.ctx;

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req) => app.ctx.ip(req) } } }, async (req, reply) => {
    const body = parse(LoginBody, req.body, reply);
    if (!body) return;
    const user = db.select().from(tables.user).where(eq(tables.user.email, body.email)).get();
    const ok = user && !user.disabledAt ? await verifyPassword(user.passwordHash, body.password) : await burnPasswordCheck(body.password);
    if (!user || !ok) {
      db.insert(tables.auditLog).values({ action: "auth.login_failed", detail: { email: body.email }, ip: app.ctx.ip(req) }).run();
      return reply.code(401).send({ error: "bad_credentials", message: "That email and password don't match." });
    }
    db.update(tables.user).set({ lastLoginAt: new Date() }).where(eq(tables.user.id, user.id)).run();
    db.insert(tables.auditLog).values({ userId: user.id, action: "auth.login", ip: app.ctx.ip(req) }).run();
    const { token, expiresAt } = createSession(db, user.id, { ip: app.ctx.ip(req), userAgent: req.headers["user-agent"] });
    setSessionCookie(reply, token, expiresAt, req.protocol === "https" || !!req.headers["cf-ray"]);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) destroySession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req) => ({
    user: req.user ? { ...req.user, scoped: req.shootScope !== null } : null,
    studio: { name: settings.get("studio.name") ?? "", timezone: settings.get("studio.timezone") ?? "UTC" },
  }));

  app.post("/password", { preHandler: requireUser }, async (req, reply) => {
    const body = parse(PasswordBody, req.body, reply);
    if (!body) return;
    const user = db.select().from(tables.user).where(eq(tables.user.id, req.user!.id)).get()!;
    if (!(await verifyPassword(user.passwordHash, body.current))) {
      return reply.code(400).send({ error: "invalid", field: "current", message: "Your current password isn't right." });
    }
    db.update(tables.user).set({ passwordHash: await hashPassword(body.next) }).where(eq(tables.user.id, user.id)).run();
    // Sign out every other device.
    const keep = req.cookies[SESSION_COOKIE];
    const sessions = db.select({ id: tables.session.id }).from(tables.session).where(eq(tables.session.userId, user.id)).all();
    const keepId = keep ? crypto.createHash("sha256").update(keep).digest("hex") : "";
    for (const s of sessions) if (s.id !== keepId) db.delete(tables.session).where(eq(tables.session.id, s.id)).run();
    db.insert(tables.auditLog).values({ userId: user.id, action: "auth.password_changed", ip: app.ctx.ip(req) }).run();
    return { ok: true };
  });
}
