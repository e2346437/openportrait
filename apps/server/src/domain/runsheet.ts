import { asc, eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";

const { shoot, shootRunItem } = tables;

export interface RunItemInput {
  /** Minutes after midnight, studio time zone. */
  startMinutes: number;
  durationMinutes?: number | null;
  title: string;
  location?: string | null;
  notes?: string | null;
}

const DAY = 24 * 60;

function clean(input: Partial<RunItemInput>, partial: boolean) {
  const out: Partial<typeof shootRunItem.$inferInsert> = {};
  if (!partial || input.startMinutes !== undefined) {
    const m = input.startMinutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || m >= DAY) throw new DomainError("invalid", "Choose a time of day.");
    out.startMinutes = m;
  }
  if (input.durationMinutes !== undefined) {
    const d = input.durationMinutes;
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > DAY)) throw new DomainError("invalid", "Enter how long it lasts in minutes, or leave it blank.");
    out.durationMinutes = d;
  }
  if (!partial || input.title !== undefined) {
    const t = (input.title ?? "").trim().slice(0, 160);
    if (!t) throw new DomainError("invalid", "Say what happens at that time.");
    out.title = t;
  }
  if (input.location !== undefined) out.location = input.location?.trim().slice(0, 200) || null;
  if (input.notes !== undefined) out.notes = input.notes?.trim().slice(0, 2000) || null;
  return out;
}

function shootExists(ctx: ServiceContext, shootId: string) {
  if (!ctx.db.select({ id: shoot.id }).from(shoot).where(eq(shoot.id, shootId)).get()) throw notFound("Shoot");
}

function view(r: typeof shootRunItem.$inferSelect) {
  return { id: r.id, shootId: r.shootId, startMinutes: r.startMinutes, durationMinutes: r.durationMinutes, title: r.title, location: r.location, notes: r.notes };
}

export function listRunSheet(ctx: ServiceContext, shootId: string) {
  shootExists(ctx, shootId);
  return ctx.db.select().from(shootRunItem).where(eq(shootRunItem.shootId, shootId)).orderBy(asc(shootRunItem.startMinutes), asc(shootRunItem.createdAt)).all().map(view);
}

export function addRunItem(ctx: ServiceContext, shootId: string, input: RunItemInput) {
  shootExists(ctx, shootId);
  const count = ctx.db.select({ id: shootRunItem.id }).from(shootRunItem).where(eq(shootRunItem.shootId, shootId)).all().length;
  if (count >= 100) throw new DomainError("invalid", "A run sheet can have up to 100 lines.");
  const values = clean(input, false);
  const id = newId();
  ctx.db.insert(shootRunItem).values({ id, shootId, startMinutes: values.startMinutes!, title: values.title!, durationMinutes: values.durationMinutes ?? null, location: values.location ?? null, notes: values.notes ?? null }).run();
  return view(ctx.db.select().from(shootRunItem).where(eq(shootRunItem.id, id)).get()!);
}

export function updateRunItem(ctx: ServiceContext, shootId: string, itemId: string, input: Partial<RunItemInput>) {
  const row = ctx.db.select().from(shootRunItem).where(eq(shootRunItem.id, itemId)).get();
  if (!row || row.shootId !== shootId) throw notFound("That line");
  const values = clean(input, true);
  if (Object.keys(values).length) ctx.db.update(shootRunItem).set(values).where(eq(shootRunItem.id, itemId)).run();
  return view(ctx.db.select().from(shootRunItem).where(eq(shootRunItem.id, itemId)).get()!);
}

export function removeRunItem(ctx: ServiceContext, shootId: string, itemId: string) {
  const row = ctx.db.select().from(shootRunItem).where(eq(shootRunItem.id, itemId)).get();
  if (!row || row.shootId !== shootId) throw notFound("That line");
  ctx.db.delete(shootRunItem).where(eq(shootRunItem.id, itemId)).run();
  return { ok: true };
}
