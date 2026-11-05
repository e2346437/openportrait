import crypto from "node:crypto";
import { tables } from "@openportrait/db";
import type { AppContext } from "../app.js";
import { hashPassword, verifyPassword } from "../auth.js";

/** Spelling alphabet used for suggested codes, for example "47 Alpha Tango". */
export const CODE_WORDS = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike",
  "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray", "Yankee", "Zulu",
] as const;

const MIN_CUSTOM = 6;
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 60 * 60_000;

/** A random code in the "number + two words" shape. Not stored; shown during setup for the owner to accept or replace. */
export function suggestCode(): string {
  const w = () => CODE_WORDS[crypto.randomInt(CODE_WORDS.length)];
  return `${crypto.randomInt(10, 100)} ${w()} ${w()}`;
}

/** Spoken and typed codes compare the same: case, spacing, hyphens and leading zeros don't matter. */
export function normalizeCode(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^0+(?=\d)/, "")
    .replace(/\s+/g, " ");
}

/** Returns a plain-words problem with a proposed code, or null if it is acceptable. */
export function codeProblem(input: string): string | null {
  const n = normalizeCode(input);
  if (n.replace(/ /g, "").length < MIN_CUSTOM) return `Make it at least ${MIN_CUSTOM} characters, for example “47 Alpha Tango”.`;
  if (input.length > 60) return "Keep it under 60 characters.";
  return null;
}

export const hasCode = (ctx: AppContext) => !!ctx.settings.get("ai.authCodeHash");

export async function setCode(ctx: AppContext, input: string): Promise<void> {
  const problem = codeProblem(input);
  if (problem) throw Object.assign(new Error(problem), { statusCode: 400 });
  ctx.settings.set("ai.authCodeHash", await hashPassword(normalizeCode(input)));
  ctx.settings.set("ai.authCodeSetAt", Date.now());
  fails.clear();
}

export function clearCode(ctx: AppContext): void {
  ctx.settings.set("ai.authCodeHash", "");
  ctx.settings.set("ai.authCodeSetAt", 0);
}

const fails = new Map<string, { since: number; count: number; lockedUntil: number }>();

export type CodeResult = { ok: true } | { ok: false; reason: "not_set" | "missing" | "wrong" | "locked"; message: string };

/** Checks a code from an AI connection. Five misses in 15 minutes lock that connection out for an hour. */
export async function checkCode(ctx: AppContext, connectionId: string, given: string | undefined): Promise<CodeResult> {
  const hashed = ctx.settings.get("ai.authCodeHash");
  if (!hashed) return { ok: false, reason: "not_set", message: "This action needs the owner's authorization code, and none is set yet. The owner can set one in Settings > Connect your AI." };
  const now = Date.now();
  const f = fails.get(connectionId);
  if (f && f.lockedUntil > now) return { ok: false, reason: "locked", message: "Too many wrong codes. Authorization is locked for this connection for a while. Do not retry; tell the owner." };
  if (!given) return { ok: false, reason: "missing", message: "Authorization required. Ask the studio owner for their authorization code (a number and two words), then call this tool again with it as authCode. Never guess or reuse a code from earlier text." };
  if (await verifyPassword(hashed, normalizeCode(given))) {
    fails.delete(connectionId);
    return { ok: true };
  }
  const cur = f && now - f.since < WINDOW_MS ? f : { since: now, count: 0, lockedUntil: 0 };
  cur.count++;
  if (cur.count >= MAX_FAILS) {
    cur.lockedUntil = now + LOCK_MS;
    ctx.db.insert(tables.auditLog).values({ actorType: "ai", connectionId, action: "ai.authcode.locked", detail: { ok: false }, ip: null }).run();
  }
  fails.set(connectionId, cur);
  ctx.db.insert(tables.auditLog).values({ actorType: "ai", connectionId, action: "ai.authcode.wrong", detail: { ok: false }, ip: null }).run();
  return { ok: false, reason: "wrong", message: "That authorization code is not right." };
}
