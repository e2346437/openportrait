import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { hashPassword } from "../auth.js";
import type { Secrets } from "../secrets.js";
import { DomainError, linkTo, notFound, type ServiceContext } from "./context.js";

const { masterAccess, shoot } = tables;
export type MasterRow = typeof masterAccess.$inferSelect;

/** The link is `id.signature`; the signature covers the id and version, so a bumped version retires every older link. */
export function masterToken(secrets: Secrets, row: Pick<MasterRow, "id" | "version">): string {
  return `${row.id}.${secrets.sign("master", `${row.id}:${row.version}`)}`;
}

/** Finds the page a link opens, or null for anything wrong, switched off, retired or expired. Never says which. */
export function resolveMaster(ctx: ServiceContext, secrets: Secrets, token: string): MasterRow | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || token.length > 200) return null;
  const id = token.slice(0, dot);
  const row = ctx.db.select().from(masterAccess).where(eq(masterAccess.id, id)).get();
  if (!row) return null;
  if (!secrets.verify("master", `${row.id}:${row.version}`, token.slice(dot + 1))) return null;
  if (row.disabledAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export function describeMaster(ctx: ServiceContext, secrets: Secrets, parentId: string) {
  const row = ctx.db.select().from(masterAccess).where(eq(masterAccess.parentId, parentId)).get();
  if (!row) return { enabled: false as const };
  return {
    enabled: !row.disabledAt,
    link: row.disabledAt ? null : linkTo(ctx, `/d/${masterToken(secrets, row)}`),
    hasPassword: !!row.passwordHash,
    expiresAt: row.expiresAt?.getTime() ?? null,
    expired: !!row.expiresAt && row.expiresAt.getTime() < Date.now(),
    views: row.views,
    lastViewedAt: row.lastViewedAt?.getTime() ?? null,
  };
}

function dayRow(ctx: ServiceContext, parentId: string) {
  const row = ctx.db.select().from(shoot).where(eq(shoot.id, parentId)).get();
  if (!row) throw notFound("Shoot");
  if (row.kind !== "group_day") throw new DomainError("invalid", "Only a group day can have a page for the organisation.");
  return row;
}

export async function saveMaster(ctx: ServiceContext, secrets: Secrets, parentId: string, input: { enabled?: boolean; rotate?: boolean; password?: string | null; expiresAt?: number | null }) {
  dayRow(ctx, parentId);
  const existing = ctx.db.select().from(masterAccess).where(eq(masterAccess.parentId, parentId)).get();
  const patch: Partial<MasterRow> = {};
  if (input.password !== undefined) {
    const pw = input.password?.trim() ?? "";
    if (pw && pw.length < 6) throw new DomainError("invalid", "Use a password of at least 6 characters.");
    patch.passwordHash = pw ? await hashPassword(pw) : null;
  }
  if (input.expiresAt !== undefined) {
    if (input.expiresAt !== null && (!Number.isFinite(input.expiresAt) || input.expiresAt < Date.now())) throw new DomainError("invalid", "Pick an end date in the future.");
    patch.expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
  }
  if (!existing) {
    if (input.enabled === false) return describeMaster(ctx, secrets, parentId);
    ctx.db.insert(masterAccess).values({ id: crypto.randomBytes(16).toString("base64url"), parentId, ...patch }).run();
  } else {
    if (input.enabled === true) patch.disabledAt = null;
    if (input.enabled === false) patch.disabledAt = new Date();
    // A new link is needed when the old one leaked, and a changed password ends earlier sign-ins too.
    if (input.rotate || input.password !== undefined) patch.version = existing.version + 1;
    if (Object.keys(patch).length) ctx.db.update(masterAccess).set(patch).where(eq(masterAccess.id, existing.id)).run();
  }
  return describeMaster(ctx, secrets, parentId);
}
