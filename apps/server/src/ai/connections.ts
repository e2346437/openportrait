import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import { AREAS, type Caller, type Level } from "./registry.js";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const TOKEN_PREFIX = "opai_";

export interface ConnectionView {
  id: string;
  label: string;
  kind: "token" | "oauth";
  level: Level;
  areas: string[];
  tokenHint: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
}

const view = (r: typeof tables.aiConnection.$inferSelect): ConnectionView => ({
  id: r.id,
  label: r.label,
  kind: r.kind,
  level: r.level,
  areas: r.areas,
  tokenHint: r.tokenHint,
  createdAt: r.createdAt.getTime(),
  expiresAt: r.expiresAt?.getTime() ?? null,
  lastUsedAt: r.lastUsedAt?.getTime() ?? null,
  expired: !!r.expiresAt && r.expiresAt.getTime() <= Date.now(),
});

export function listConnections(db: Db): ConnectionView[] {
  return db.select().from(tables.aiConnection).where(isNull(tables.aiConnection.revokedAt)).orderBy(desc(tables.aiConnection.createdAt)).all().map(view);
}

export function createConnection(db: Db, input: { label: string; level: Level; areas: string[]; expiresInDays?: number | null; userId: string }): { connection: ConnectionView; token: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const row = db
    .insert(tables.aiConnection)
    .values({
      id: crypto.randomUUID(),
      label: input.label,
      kind: "token",
      tokenHash: sha256(token),
      tokenHint: token.slice(-4),
      level: input.level,
      areas: input.areas.filter((a) => (AREAS as readonly string[]).includes(a)),
      createdBy: input.userId,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning()
    .get();
  return { connection: view(row), token };
}

/** Declines everything a connection still has waiting, so nothing it queued can run once its access is gone. */
export function cancelPendingApprovals(db: Db, connectionId: string, reason: string): void {
  db.update(tables.aiApproval)
    .set({ status: "declined", decidedAt: new Date(), result: { error: reason } })
    .where(and(eq(tables.aiApproval.connectionId, connectionId), eq(tables.aiApproval.status, "pending")))
    .run();
}

export function revokeConnection(db: Db, id: string): boolean {
  const revoked = db.update(tables.aiConnection).set({ revokedAt: new Date() }).where(and(eq(tables.aiConnection.id, id), isNull(tables.aiConnection.revokedAt))).run().changes > 0;
  if (revoked) cancelPendingApprovals(db, id, "This connection was revoked, so the request was cancelled.");
  return revoked;
}

/** Resolves a bearer token to a caller, or null if it is unknown, revoked or expired. */
export function authenticate(db: Db, token: string): Caller | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const r = db.select().from(tables.aiConnection).where(and(eq(tables.aiConnection.tokenHash, sha256(token)), isNull(tables.aiConnection.revokedAt))).get();
  if (!r || (r.expiresAt && r.expiresAt.getTime() <= Date.now())) return null;
  if (r.accessExpiresAt && r.accessExpiresAt.getTime() <= Date.now()) return null; // OAuth access tokens are short-lived
  if (!r.lastUsedAt || Date.now() - r.lastUsedAt.getTime() > 10_000) {
    db.update(tables.aiConnection).set({ lastUsedAt: new Date() }).where(eq(tables.aiConnection.id, r.id)).run();
  }
  return { connectionId: r.id, label: r.label, level: r.level, areas: r.areas };
}
