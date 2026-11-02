import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "../totp.js";

const LoginBody = z.object({ email: z.string().trim().toLowerCase().min(1, "Enter your email."), password: z.string().min(1, "Enter your password.") });
const PasswordBody = z.object({ current: z.string().min(1, "Enter your current password."), next: password });

const MfaLoginBody = z.object({ challenge: z.string().min(1), code: z.string().trim().min(1, "Enter the code from your authenticator app.").max(40) });
const CodeBody = z.object({ code: z.string().trim().min(1, "Enter the 6-digit code.").max(40) });
const ConfirmBody = z.object({ password: z.string().min(1, "Enter your password.") });
const DisableBody = ConfirmBody.extend({ code: z.string().trim().min(1, "Enter a code from your authenticator app, or a recovery code.").max(40) });

const CHALLENGE_SECONDS = 300;
const MAX_CODE_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export async function authRoutes(app: FastifyInstance) {
  const { db, settings, secrets } = app.ctx;

  /** Wrong-code counters per account, so a stolen password can't be used to guess codes across many IPs. */
  const failures = new Map<string, { count: number; lockedUntil: number }>();
  const locked = (userId: string) => (failures.get(userId)?.lockedUntil ?? 0) > Date.now();
  const noteFailure = (userId: string) => {
    const f = failures.get(userId) ?? { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_CODE_FAILURES) Object.assign(f, { count: 0, lockedUntil: Date.now() + LOCK_MS });
    failures.set(userId, f);
  };

  const makeChallenge = (userId: string) => {
    const body = `${userId}.${Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS}`;
    return `${body}.${secrets.sign("mfa-challenge", body)}`;
  };
  const readChallenge = (challenge: string): string | null => {
    const [userId, exp, sig] = challenge.split(".");
    if (!userId || !exp || !sig || !secrets.verify("mfa-challenge", `${userId}.${exp}`, sig)) return null;
    return Number(exp) * 1000 > Date.now() ? userId : null;
  };

  type UserRow = typeof tables.user.$inferSelect;
  /** Accepts a current authenticator code or an unused recovery code. Recovery codes are spent when used. */
  const checkSecondStep = (user: UserRow, code: string): "totp" | "recovery" | null => {
    if (!user.totpSecret || !user.totpEnabledAt) return null;
    const step = verifyTotp(secrets.decrypt(user.totpSecret), code, user.totpLastStep);
    if (step !== null) {
      db.update(tables.user).set({ totpLastStep: step }).where(eq(tables.user.id, user.id)).run();
      return "totp";
    }
    const hashes: string[] = JSON.parse(user.recoveryCodes ?? "[]");
    const h = hashRecoveryCode(code);
    if (h && hashes.includes(h)) {
      db.update(tables.user).set({ recoveryCodes: JSON.stringify(hashes.filter((x) => x !== h)) }).where(eq(tables.user.id, user.id)).run();
      return "recovery";
    }
    return null;
  };

  const startSession = (req: FastifyRequest, reply: FastifyReply, user: UserRow) => {
    db.update(tables.user).set({ lastLoginAt: new Date() }).where(eq(tables.user.id, user.id)).run();
    db.insert(tables.auditLog).values({ userId: user.id, action: "auth.login", ip: app.ctx.ip(req) }).run();
    const { token, expiresAt } = createSession(db, user.id, { ip: app.ctx.ip(req), userAgent: req.headers["user-agent"] });
    setSessionCookie(reply, token, expiresAt, req.protocol === "https" || !!req.headers["cf-ray"]);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  };

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req) => app.ctx.ip(req) } } }, async (req, reply) => {
    const body = parse(LoginBody, req.body, reply);
    if (!body) return;
    const user = db.select().from(tables.user).where(eq(tables.user.email, body.email)).get();
    const ok = user && !user.disabledAt ? await verifyPassword(user.passwordHash, body.password) : await burnPasswordCheck(body.password);
    if (!user || !ok) {
      db.insert(tables.auditLog).values({ action: "auth.login_failed", detail: { email: body.email }, ip: app.ctx.ip(req) }).run();
      return reply.code(401).send({ error: "bad_credentials", message: "That email and password don't match." });
    }
    if (user.totpEnabledAt) return { mfaRequired: true, challenge: makeChallenge(user.id) };
    return startSession(req, reply, user);
  });

  app.post("/login/mfa", { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req) => app.ctx.ip(req) } } }, async (req, reply) => {
    const body = parse(MfaLoginBody, req.body, reply);
    if (!body) return;
    const userId = readChallenge(body.challenge);
    const user = userId ? db.select().from(tables.user).where(eq(tables.user.id, userId)).get() : undefined;
    if (!user || user.disabledAt || !user.totpEnabledAt) {
      return reply.code(401).send({ error: "challenge_expired", message: "That sign-in timed out. Enter your password again." });
    }
    if (locked(user.id)) {
      return reply.code(429).send({ error: "locked", message: "Too many wrong codes. Try again in 15 minutes." });
    }
    const how = checkSecondStep(user, body.code);
    if (!how) {
      noteFailure(user.id);
      db.insert(tables.auditLog).values({ userId: user.id, action: "auth.mfa_failed", ip: app.ctx.ip(req) }).run();
      return reply.code(401).send({ error: "bad_code", field: "code", message: "That code isn't right. Check the app and try again." });
    }
    failures.delete(user.id);
    if (how === "recovery") db.insert(tables.auditLog).values({ userId: user.id, action: "auth.recovery_code_used", ip: app.ctx.ip(req) }).run();
    return startSession(req, reply, user);
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
  const me = (req: FastifyRequest) => db.select().from(tables.user).where(eq(tables.user.id, req.user!.id)).get()!;
  const signOutElsewhere = (req: FastifyRequest, userId: string) => {
    const keep = req.cookies[SESSION_COOKIE];
    const keepId = keep ? crypto.createHash("sha256").update(keep).digest("hex") : "";
    for (const s of db.select({ id: tables.session.id }).from(tables.session).where(eq(tables.session.userId, userId)).all()) {
      if (s.id !== keepId) db.delete(tables.session).where(eq(tables.session.id, s.id)).run();
    }
  };
  const issueRecoveryCodes = (userId: string) => {
    const codes = newRecoveryCodes();
    db.update(tables.user).set({ recoveryCodes: JSON.stringify(codes.map(hashRecoveryCode)) }).where(eq(tables.user.id, userId)).run();
    return codes;
  };

  app.get("/mfa", { preHandler: requireUser }, async (req) => {
    const user = me(req);
    return { enabled: !!user.totpEnabledAt, recoveryCodesLeft: user.totpEnabledAt ? (JSON.parse(user.recoveryCodes ?? "[]") as string[]).length : 0 };
  });

  /** Step 1: make a secret and show it. Nothing changes at sign-in until a code from the app proves it was added. */
  app.post("/mfa/setup", { preHandler: requireUser }, async (req, reply) => {
    const body = parse(ConfirmBody, req.body, reply);
    if (!body) return;
    const user = me(req);
    if (user.totpEnabledAt) return reply.code(409).send({ error: "already_enabled", message: "Two-step sign-in is already on." });
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      return reply.code(400).send({ error: "invalid", field: "password", message: "That password isn't right." });
    }
    const secret = newTotpSecret();
    db.update(tables.user).set({ totpSecret: secrets.encrypt(secret), totpLastStep: null }).where(eq(tables.user.id, user.id)).run();
    const issuer = settings.get("studio.name")?.trim() || "OpenPortrait";
    return { secret, uri: otpauthUri(secret, user.email, issuer) };
  });

  /** Step 2: a valid code turns it on and shows the recovery codes once. */
  app.post("/mfa/enable", { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req) => app.ctx.ip(req) } } }, async (req, reply) => {
    const body = parse(CodeBody, req.body, reply);
    if (!body) return;
    const user = me(req);
    if (user.totpEnabledAt || !user.totpSecret) return reply.code(409).send({ error: "no_setup", message: "Start setup again to get a new key." });
    if (locked(user.id)) return reply.code(429).send({ error: "locked", message: "Too many wrong codes. Try again in 15 minutes." });
    const step = verifyTotp(secrets.decrypt(user.totpSecret), body.code, null);
    if (step === null) {
      noteFailure(user.id);
      return reply.code(400).send({ error: "bad_code", field: "code", message: "That code isn't right. Check the app and try again." });
    }
    failures.delete(user.id);
    db.update(tables.user).set({ totpEnabledAt: new Date(), totpLastStep: step }).where(eq(tables.user.id, user.id)).run();
    const recoveryCodes = issueRecoveryCodes(user.id);
    signOutElsewhere(req, user.id);
    db.insert(tables.auditLog).values({ userId: user.id, action: "auth.mfa_enabled", ip: app.ctx.ip(req) }).run();
    return { ok: true, recoveryCodes };
  });

  app.post("/mfa/recovery-codes", { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req) => app.ctx.ip(req) } } }, async (req, reply) => {
    const body = parse(DisableBody, req.body, reply);
    if (!body) return;
    const user = me(req);
    if (!user.totpEnabledAt) return reply.code(409).send({ error: "not_enabled", message: "Two-step sign-in isn't on." });
    if (!(await verifyPassword(user.passwordHash, body.password)) || locked(user.id) || !checkSecondStep(user, body.code)) {
      noteFailure(user.id);
      return reply.code(400).send({ error: "invalid", field: "code", message: "Your password or code isn't right." });
    }
    db.insert(tables.auditLog).values({ userId: user.id, action: "auth.recovery_codes_regenerated", ip: app.ctx.ip(req) }).run();
    return { recoveryCodes: issueRecoveryCodes(user.id) };
  });

  app.post("/mfa/disable", { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req) => app.ctx.ip(req) } } }, async (req, reply) => {
    const body = parse(DisableBody, req.body, reply);
    if (!body) return;
    const user = me(req);
    if (!user.totpEnabledAt) return reply.code(409).send({ error: "not_enabled", message: "Two-step sign-in isn't on." });
    if (!(await verifyPassword(user.passwordHash, body.password)) || locked(user.id) || !checkSecondStep(user, body.code)) {
      noteFailure(user.id);
      return reply.code(400).send({ error: "invalid", field: "code", message: "Your password or code isn't right." });
    }
    failures.delete(user.id);
    db.update(tables.user).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null }).where(eq(tables.user.id, user.id)).run();
    db.insert(tables.auditLog).values({ userId: user.id, action: "auth.mfa_disabled", ip: app.ctx.ip(req) }).run();
    return { ok: true };
  });
}
