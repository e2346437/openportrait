import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { displayName, logActivity } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { addDays, isYmd, ymdIn } from "./time.js";

const { shoot, shootEvent, shootTask, shootTypeTask, shootType, contact } = tables;

const clean = (title: string | undefined): string => {
  const t = (title ?? "").trim().slice(0, 200);
  if (!t) throw new DomainError("invalid", "Give the task a name.");
  return t;
};
const cleanDue = (d: string | null | undefined): string | null => {
  if (d === null || d === undefined || d === "") return null;
  if (!isYmd(d)) throw new DomainError("invalid", "Enter the due date like 2027-03-14.");
  return d;
};

function taskRow(ctx: ServiceContext, id: string) {
  const t = ctx.db.select().from(shootTask).where(eq(shootTask.id, id)).get();
  if (!t) throw notFound("That task");
  return t;
}

const view = (t: typeof shootTask.$inferSelect, today: string) => ({
  id: t.id,
  shootId: t.shootId,
  title: t.title,
  dueDate: t.dueDate,
  done: !!t.doneAt,
  doneAt: t.doneAt ? t.doneAt.getTime() : null,
  overdue: !t.doneAt && !!t.dueDate && t.dueDate < today,
});

const todayOf = (ctx: ServiceContext) => ymdIn(Date.now(), ctx.settings.get("studio.timezone") ?? "UTC");

export function listForShoot(ctx: ServiceContext, shootId: string) {
  const today = todayOf(ctx);
  return ctx.db.select().from(shootTask).where(eq(shootTask.shootId, shootId)).orderBy(asc(shootTask.position), asc(shootTask.createdAt)).all().map((t) => view(t, today));
}

export interface TaskQuery {
  /** open (default) or done. */
  status?: "open" | "done";
  /** Only tasks due on or before this day. Tasks with no due date are left out when it is set. */
  dueBy?: string;
  shootId?: string;
  limit?: number;
}

/** Tasks across every shoot, soonest due first, with who they are for. Cancelled shoots are left out. */
export function listTasks(ctx: ServiceContext, q: TaskQuery = {}) {
  const today = todayOf(ctx);
  if (q.dueBy && !isYmd(q.dueBy)) throw new DomainError("invalid", "Choose a date.");
  const where = and(
    q.status === "done" ? isNotNull(shootTask.doneAt) : isNull(shootTask.doneAt),
    q.dueBy ? lte(shootTask.dueDate, q.dueBy) : undefined,
    q.shootId ? eq(shootTask.shootId, q.shootId) : undefined,
    sql`${shoot.status} != 'cancelled'`,
  );
  const rows = ctx.db
    .select({ t: shootTask, subject: shoot.subject, shootStatus: shoot.status, typeName: shootType.name, c: contact })
    .from(shootTask)
    .innerJoin(shoot, eq(shoot.id, shootTask.shootId))
    .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
    .innerJoin(contact, eq(contact.id, shoot.primaryContactId))
    .where(where)
    // Undated tasks sort last; SQLite puts NULL first, so flip it.
    .orderBy(sql`${shootTask.dueDate} is null`, asc(shootTask.dueDate), asc(shootTask.createdAt))
    .limit(Math.min(Math.max(q.limit ?? 200, 1), 500))
    .all();
  return rows.map((r) => ({ ...view(r.t, today), shoot: { id: r.t.shootId, subject: r.subject, type: r.typeName, status: r.shootStatus, contactName: displayName(r.c) } }));
}

export function addTask(ctx: ServiceContext, shootId: string, input: { title: string; dueDate?: string | null }) {
  if (!ctx.db.select({ id: shoot.id }).from(shoot).where(eq(shoot.id, shootId)).get()) throw notFound("Shoot");
  const position = ctx.db.select({ n: sql<number>`count(*)` }).from(shootTask).where(eq(shootTask.shootId, shootId)).get()?.n ?? 0;
  const id = newId();
  ctx.db.insert(shootTask).values({ id, shootId, title: clean(input.title), dueDate: cleanDue(input.dueDate), position }).run();
  return view(taskRow(ctx, id), todayOf(ctx));
}

export function updateTask(ctx: ServiceContext, id: string, input: { title?: string; dueDate?: string | null; done?: boolean }) {
  const t = taskRow(ctx, id);
  const set: Partial<typeof shootTask.$inferInsert> = {};
  if (input.title !== undefined) set.title = clean(input.title);
  if (input.dueDate !== undefined) set.dueDate = cleanDue(input.dueDate);
  if (input.done !== undefined && input.done !== !!t.doneAt) {
    set.doneAt = input.done ? new Date() : null;
    if (input.done) {
      const s = ctx.db.select().from(shoot).where(eq(shoot.id, t.shootId)).get();
      if (s) logActivity(ctx, { contactId: s.primaryContactId, shootId: s.id, kind: "task.done", summary: `Done: ${t.title}` });
    }
  }
  if (Object.keys(set).length) ctx.db.update(shootTask).set(set).where(eq(shootTask.id, id)).run();
  return view(taskRow(ctx, id), todayOf(ctx));
}

export function deleteTask(ctx: ServiceContext, id: string) {
  taskRow(ctx, id);
  ctx.db.delete(shootTask).where(eq(shootTask.id, id)).run();
  return { ok: true };
}

// ---- the checklist each shoot type starts with ----

export function listTypeTasks(ctx: ServiceContext, shootTypeId: string) {
  return ctx.db.select({ title: shootTypeTask.title, dueDays: shootTypeTask.dueDays }).from(shootTypeTask).where(eq(shootTypeTask.shootTypeId, shootTypeId)).orderBy(asc(shootTypeTask.position)).all();
}

/** Replaces a type's starter checklist. */
export function setTypeTasks(ctx: ServiceContext, shootTypeId: string, items: Array<{ title: string; dueDays?: number | null }>) {
  if (!ctx.db.select({ id: shootType.id }).from(shootType).where(eq(shootType.id, shootTypeId)).get()) throw notFound("Shoot type");
  if (items.length > 40) throw new DomainError("invalid", "That's more than 40 tasks. Keep the checklist short.");
  const rows = items.map((i, position) => {
    const dueDays = i.dueDays ?? null;
    if (dueDays !== null && (!Number.isInteger(dueDays) || Math.abs(dueDays) > 3650)) throw new DomainError("invalid", "Days from the shoot must be a whole number.");
    return { id: newId(), shootTypeId, title: clean(i.title), dueDays, position };
  });
  ctx.db.transaction((tx) => {
    tx.delete(shootTypeTask).where(eq(shootTypeTask.shootTypeId, shootTypeId)).run();
    for (const r of rows) tx.insert(shootTypeTask).values(r).run();
  });
  return listTypeTasks(ctx, shootTypeId);
}

/** Copies the type's checklist onto a new shoot. Due dates count from the shoot's first date; with no date they are left open. */
export function applyTypeTasks(ctx: ServiceContext, shootId: string) {
  const s = ctx.db.select().from(shoot).where(eq(shoot.id, shootId)).get();
  if (!s) return;
  const items = ctx.db.select().from(shootTypeTask).where(eq(shootTypeTask.shootTypeId, s.shootTypeId)).orderBy(asc(shootTypeTask.position)).all();
  if (!items.length) return;
  const first = ctx.db.select({ at: shootEvent.startsAt }).from(shootEvent).where(eq(shootEvent.shootId, shootId)).orderBy(asc(shootEvent.startsAt)).get();
  const day = first ? ymdIn(first.at.getTime(), ctx.settings.get("studio.timezone") ?? "UTC") : null;
  items.forEach((i, position) => {
    ctx.db.insert(shootTask).values({ id: newId(), shootId, title: i.title, dueDate: day && i.dueDays !== null ? addDays(day, i.dueDays) : null, position }).run();
  });
}
