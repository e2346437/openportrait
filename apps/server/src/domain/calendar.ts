import { and, eq, gt, lt, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { displayName } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";

const { calendarEntry, shootEvent, shoot, shootType, contact, busyBlock } = tables;

export type CalendarSource = "shoot" | "appointment" | "block" | "busy";

export interface CalendarItem {
  /** Unique across sources, e.g. "shoot:<eventId>". */
  key: string;
  source: CalendarSource;
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location: string | null;
  shootId?: string;
  shootType?: string;
  status?: string;
  contactId?: string | null;
  contactName?: string | null;
  notes?: string | null;
}

/** For all-day entries, endsAt is the start of the day after the last day (the same way Google counts them). */
export interface EntryInput {
  kind: "appointment" | "block";
  title: string;
  startsAt: number;
  endsAt: number;
  allDay?: boolean;
  location?: string | null;
  notes?: string | null;
  contactId?: string | null;
}

const MAX_RANGE_MS = 400 * 86400000;

function checkRange(from: number, to: number) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new DomainError("invalid", "Choose a date range.");
  if (to - from > MAX_RANGE_MS) throw new DomainError("invalid", "That range is too long. Choose up to a year.");
}

/** Everything on the calendar between two instants, in start order. Includes busy times from other Google calendars. */
export function listCalendar(ctx: ServiceContext, from: number, to: number, opts: { includeBusy?: boolean } = {}): CalendarItem[] {
  checkRange(from, to);
  const f = new Date(from);
  const t = new Date(to);
  const items: CalendarItem[] = [];

  const shootRows = ctx.db
    .select({
      id: shootEvent.id,
      title: shootEvent.title,
      startsAt: shootEvent.startsAt,
      endsAt: shootEvent.endsAt,
      allDay: shootEvent.allDay,
      location: shootEvent.location,
      shootId: shoot.id,
      subject: shoot.subject,
      status: shoot.status,
      type: shootType.name,
      contactId: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      company: contact.company,
      email: contact.email,
    })
    .from(shootEvent)
    .innerJoin(shoot, eq(shoot.id, shootEvent.shootId))
    .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
    .innerJoin(contact, eq(contact.id, shoot.primaryContactId))
    .where(and(lt(shootEvent.startsAt, t), gt(shootEvent.endsAt, f), sql`${shoot.status} != 'cancelled'`))
    .all();
  for (const r of shootRows) {
    items.push({
      key: `shoot:${r.id}`,
      source: "shoot",
      id: r.id,
      title: r.title ? `${r.subject}: ${r.title}` : r.subject,
      startsAt: r.startsAt.getTime(),
      endsAt: r.endsAt.getTime(),
      allDay: r.allDay,
      location: r.location,
      shootId: r.shootId,
      shootType: r.type,
      status: r.status,
      contactId: r.contactId,
      contactName: displayName(r),
    });
  }

  const entryRows = ctx.db
    .select({ e: calendarEntry, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email })
    .from(calendarEntry)
    .leftJoin(contact, eq(contact.id, calendarEntry.contactId))
    .where(and(lt(calendarEntry.startsAt, t), gt(calendarEntry.endsAt, f)))
    .all();
  for (const { e, ...c } of entryRows) {
    items.push({
      key: `${e.kind}:${e.id}`,
      source: e.kind,
      id: e.id,
      title: e.title,
      startsAt: e.startsAt.getTime(),
      endsAt: e.endsAt.getTime(),
      allDay: e.allDay,
      location: e.location,
      contactId: e.contactId,
      contactName: e.contactId ? displayName(c as Parameters<typeof displayName>[0]) : null,
      notes: e.notes,
    });
  }

  if (opts.includeBusy !== false) {
    for (const b of ctx.db.select().from(busyBlock).where(and(lt(busyBlock.startsAt, t), gt(busyBlock.endsAt, f))).all()) {
      items.push({ key: `busy:${b.calendarId}:${b.googleEventId}`, source: "busy", id: b.googleEventId, title: "Busy", startsAt: b.startsAt.getTime(), endsAt: b.endsAt.getTime(), allDay: b.allDay, location: null });
    }
  }
  return items.sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt);
}

function check(input: Partial<EntryInput>, partial: boolean) {
  if (!partial && !input.title?.trim()) throw new DomainError("invalid", "Give it a title.");
  if (input.title !== undefined && !input.title.trim()) throw new DomainError("invalid", "Give it a title.");
  if (input.startsAt !== undefined && !Number.isFinite(input.startsAt)) throw new DomainError("invalid", "Enter a start time.");
  if (input.endsAt !== undefined && !Number.isFinite(input.endsAt)) throw new DomainError("invalid", "Enter an end time.");
}

export function createEntry(ctx: ServiceContext, input: EntryInput) {
  check(input, false);
  if (input.endsAt < input.startsAt) throw new DomainError("invalid", "The end can't be before the start.");
  if (input.contactId) contactExists(ctx, input.contactId);
  const id = newId();
  ctx.db
    .insert(calendarEntry)
    .values({
      id,
      kind: input.kind,
      title: input.title.trim(),
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      allDay: input.allDay ?? false,
      location: input.location?.trim() || null,
      notes: input.notes?.trim() || null,
      contactId: input.contactId ?? null,
    })
    .run();
  return getEntry(ctx, id);
}

export function getEntry(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(calendarEntry).where(eq(calendarEntry.id, id)).get();
  if (!row) throw notFound("Calendar entry");
  return row;
}

export function updateEntry(ctx: ServiceContext, id: string, input: Partial<EntryInput>) {
  const current = getEntry(ctx, id);
  check(input, true);
  const startsAt = input.startsAt ?? current.startsAt.getTime();
  const endsAt = input.endsAt ?? current.endsAt.getTime();
  if (endsAt < startsAt) throw new DomainError("invalid", "The end can't be before the start.");
  if (input.contactId) contactExists(ctx, input.contactId);
  ctx.db
    .update(calendarEntry)
    .set({
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      ...(input.location !== undefined ? { location: input.location?.trim() || null } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    })
    .where(eq(calendarEntry.id, id))
    .run();
  return getEntry(ctx, id);
}

export function deleteEntry(ctx: ServiceContext, id: string) {
  const res = ctx.db.delete(calendarEntry).where(eq(calendarEntry.id, id)).run();
  if (!res.changes) throw notFound("Calendar entry");
  return { ok: true };
}

function contactExists(ctx: ServiceContext, id: string) {
  if (!ctx.db.select({ id: contact.id }).from(contact).where(eq(contact.id, id)).get()) throw notFound("Contact");
}

/** Merged busy intervals (shoots, appointments, blocks, other Google calendars) in a range. Used by schedulers. */
export function busyIntervals(ctx: ServiceContext, from: number, to: number): Array<[number, number]> {
  const spans = listCalendar(ctx, from, to)
    .map((i) => [i.startsAt, i.endsAt] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** Free gaps at least `minutes` long inside [from, to], for "find a time". */
export function findFreeTime(ctx: ServiceContext, from: number, to: number, minutes: number): Array<{ startsAt: number; endsAt: number }> {
  if (!Number.isFinite(minutes) || minutes < 5) throw new DomainError("invalid", "Choose a length of at least 5 minutes.");
  const need = minutes * 60000;
  const out: Array<{ startsAt: number; endsAt: number }> = [];
  let cursor = from;
  for (const [s, e] of busyIntervals(ctx, from, to)) {
    if (s - cursor >= need) out.push({ startsAt: cursor, endsAt: s });
    cursor = Math.max(cursor, e);
  }
  if (to - cursor >= need) out.push({ startsAt: cursor, endsAt: to });
  return out;
}

