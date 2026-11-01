import crypto from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { tables, type Db } from "@openportrait/db";

export const SESSION_COOKIE = "op_session";
const SESSION_DAYS = 30;

export type SessionUser = Pick<typeof tables.user.$inferSelect, "id" | "email" | "name" | "role">;

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON);
}

export function verifyPassword(stored: string, password: string): Promise<boolean> {
  return verify(stored, password).catch(() => false);
}

/** A precomputed hash so a login for an unknown email takes as long as a real one. */
let dummyHash: Promise<string> | null = null;
export function burnPasswordCheck(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  return dummyHash.then((h) => verifyPassword(h, password));
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(db: Db, userId: string, meta: { ip?: string; userAgent?: string }): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  db.insert(tables.session)
    .values({ id: sha256(token), userId, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null })
    .run();
  return { token, expiresAt };
}

export function destroySession(db: Db, token: string): void {
  db.delete(tables.session).where(eq(tables.session.id, sha256(token))).run();
}

export function lookupSession(db: Db, token: string): SessionUser | null {
  const row = db
    .select({ id: tables.user.id, email: tables.user.email, name: tables.user.name, role: tables.user.role, sessionId: tables.session.id, lastSeenAt: tables.session.lastSeenAt })
    .from(tables.session)
    .innerJoin(tables.user, eq(tables.session.userId, tables.user.id))
    .where(and(eq(tables.session.id, sha256(token)), gt(tables.session.expiresAt, new Date()), isNull(tables.user.disabledAt)))
    .get();
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    db.update(tables.session).set({ lastSeenAt: new Date() }).where(eq(tables.session.id, row.sessionId)).run();
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure, expires: expiresAt });
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: "unauthorized", message: "Please sign in." });
  }
}

export async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) return reply.code(401).send({ error: "unauthorized", message: "Please sign in." });
  if (req.user.role !== "owner") return reply.code(403).send({ error: "forbidden", message: "Only the studio owner can change this." });
}
