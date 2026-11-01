import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { busyIntervals } from "./calendar.js";
import { displayName } from "./contacts.js";
import { DomainError, linkTo, newId, notFound, type ServiceContext } from "./context.js";
import { composeEmail, queueEmail } from "./email.js";
import { createLead } from "./leads.js";
import { addDays, atTime, isYmd, weekdayOf, ymdIn } from "./time.js";

const { scheduler, schedulerBooking, calendarEntry, contact, shootType } = tables;

export type Availability = Record<string, Array<{ start: string; end: string }>>;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN = 60_000;

export interface SchedulerInput {
  name: string;
  slug?: string;
  description?: string | null;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  minNoticeHours?: number;
  maxDaysAhead?: number;
  stepMinutes?: number;
  location?: string | null;
  shootTypeId?: string | null;
  approval?: "manual" | "auto";
  availability: Availability;
  active?: boolean;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const RESERVED = new Set(["cancel", "new", "api"]);

function int(v: number | undefined, def: number, min: number, max: number, what: string): number {
  const n = v ?? def;
  if (!Number.isInteger(n) || n < min || n > max) throw new DomainError("invalid", `${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** Cleans weekly hours: valid times, start before end, sorted, no overlaps. */
export function cleanAvailability(input: Availability): Availability {
  const out: Availability = {};
  for (const [day, windows] of Object.entries(input)) {
    if (!/^[0-6]$/.test(day)) throw new DomainError("invalid", "Days are Sunday to Saturday.");
    const list = windows.map((w) => ({ start: w.start, end: w.end })).sort((a, b) => a.start.localeCompare(b.start));
    for (const w of list) {
      if (!HHMM.test(w.start) || !HHMM.test(w.end)) throw new DomainError("invalid", "Enter hours like 09:00.");
      if (w.start >= w.end) throw new DomainError("invalid", "Each block of hours has to end after it starts.");
    }
    for (let i = 1; i < list.length; i++) if (list[i]!.start < list[i - 1]!.end) throw new DomainError("invalid", "Two blocks of hours on the same day overlap.");
    if (list.length) out[day] = list;
  }
  return out;
}

function uniqueSlug(ctx: ServiceContext, wanted: string, ignoreId?: string): string {
  const base = slugify(wanted) || "booking";
  for (let n = 1; n < 200; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const hit = ctx.db.select({ id: scheduler.id }).from(scheduler).where(eq(scheduler.slug, slug)).get();
    if (!RESERVED.has(slug) && (!hit || hit.id === ignoreId)) return slug;
  }
  throw new DomainError("invalid", "Choose a different name or address.");
}

function values(ctx: ServiceContext, input: SchedulerInput) {
  if (!input.name.trim()) throw new DomainError("invalid", "Give it a name.");
  const step = int(input.stepMinutes, 30, 5, 240, "Start times");
  if (step % 5) throw new DomainError("invalid", "Start times must be a multiple of 5 minutes.");
  if (input.shootTypeId && !ctx.db.select({ id: shootType.id }).from(shootType).where(eq(shootType.id, input.shootTypeId)).get()) throw new DomainError("invalid", "Choose a shoot type.");
  return {
    name: input.name.trim().slice(0, 120),
    description: input.description?.trim().slice(0, 2000) || null,
    durationMinutes: int(input.durationMinutes, 30, 5, 600, "Length"),
    bufferBeforeMinutes: int(input.bufferBeforeMinutes, 0, 0, 240, "Time before"),
    bufferAfterMinutes: int(input.bufferAfterMinutes, 0, 0, 240, "Time after"),
    minNoticeHours: int(input.minNoticeHours, 12, 0, 720, "Notice"),
    maxDaysAhead: int(input.maxDaysAhead, 60, 1, 365, "How far ahead"),
    stepMinutes: step,
    location: input.location?.trim().slice(0, 200) || null,
    shootTypeId: input.shootTypeId || null,
    approval: input.approval ?? ("manual" as const),
    availability: cleanAvailability(input.availability),
    active: input.active ?? true,
  };
}

export function listSchedulers(ctx: ServiceContext) {
  return ctx.db.select().from(scheduler).orderBy(asc(scheduler.position), asc(scheduler.createdAt)).all();
}

export function getScheduler(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(scheduler).where(eq(scheduler.id, id)).get();
  if (!row) throw notFound("Scheduler");
  return row;
}

export function getBySlug(ctx: ServiceContext, slug: string) {
  return ctx.db.select().from(scheduler).where(eq(scheduler.slug, slug)).get() ?? null;
}

export function createScheduler(ctx: ServiceContext, input: SchedulerInput) {
  const v = values(ctx, input);
  const id = newId();
  const position = listSchedulers(ctx).length;
  ctx.db.insert(scheduler).values({ id, slug: uniqueSlug(ctx, input.slug || v.name), position, ...v }).run();
  return getScheduler(ctx, id);
}

export function updateScheduler(ctx: ServiceContext, id: string, input: SchedulerInput) {
  const current = getScheduler(ctx, id);
  const v = values(ctx, input);
  const slug = input.slug && input.slug !== current.slug ? uniqueSlug(ctx, input.slug, id) : current.slug;
  ctx.db.update(scheduler).set({ slug, ...v }).where(eq(scheduler.id, id)).run();
  return getScheduler(ctx, id);
}

export function deleteScheduler(ctx: ServiceContext, id: string) {
  getScheduler(ctx, id);
  const open = ctx.db
    .select({ id: schedulerBooking.id })
    .from(schedulerBooking)
    .where(and(eq(schedulerBooking.schedulerId, id), inArray(schedulerBooking.status, ["pending", "confirmed"]), gt(schedulerBooking.endsAt, new Date())))
    .get();
  if (open) throw new DomainError("in_use", "It has upcoming bookings. Turn it off instead, or cancel those first.");
  ctx.db.delete(scheduler).where(eq(scheduler.id, id)).run();
  return { ok: true };
}

// ---- availability ----

export interface Slot {
  startsAt: number;
  endsAt: number;
}

/** Start times a visitor can pick between two days (inclusive), in the studio's time zone. */
export function availableSlots(ctx: ServiceContext, s: typeof scheduler.$inferSelect, fromYmd: string, toYmd: string, now = Date.now()): Record<string, Slot[]> {
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  if (!isYmd(fromYmd) || !isYmd(toYmd) || toYmd < fromYmd) throw new DomainError("invalid", "Choose a range of dates.");
  const today = ymdIn(now, tz);
  const last = addDays(today, s.maxDaysAhead);
  const from = fromYmd < today ? today : fromYmd;
  const to = toYmd > last ? last : toYmd;
  const out: Record<string, Slot[]> = {};
  if (to < from) return out;
  if (to > addDays(from, 62)) throw new DomainError("invalid", "Choose a shorter range of dates.");
  const pad = Math.max(s.bufferBeforeMinutes, s.bufferAfterMinutes) * MIN;
  const busy = busyIntervals(ctx, atTime(from, "00:00", tz) - pad - 86_400_000, atTime(addDays(to, 1), "00:00", tz) + pad + 86_400_000);
  const earliest = now + s.minNoticeHours * 60 * MIN;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const slots: Slot[] = [];
    for (const w of s.availability[String(weekdayOf(day))] ?? []) {
      const windowStart = atTime(day, w.start, tz);
      const windowEnd = atTime(day, w.end, tz);
      for (let t = windowStart; t + s.durationMinutes * MIN <= windowEnd; t += s.stepMinutes * MIN) {
        const end = t + s.durationMinutes * MIN;
        if (t < earliest) continue;
        const from0 = t - s.bufferBeforeMinutes * MIN;
        const to0 = end + s.bufferAfterMinutes * MIN;
        if (busy.some(([bs, be]) => bs < to0 && be > from0)) continue;
        slots.push({ startsAt: t, endsAt: end });
      }
    }
    if (slots.length) out[day] = slots;
  }
  return out;
}

// ---- bookings ----

export interface BookingInput {
  startsAt: number;
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
  message?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function formatWhen(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
}

/**
 * A visitor picks a time. The time must be one the scheduler currently offers, so a stale page can't
 * double-book. The slot is held on the calendar at once, even while it waits for approval.
 */
export function createBooking(ctx: ServiceContext, slug: string, input: BookingInput) {
  const s = getBySlug(ctx, slug);
  if (!s || !s.active) throw new DomainError("not_found", "This booking page isn't available.", 404);
  const firstName = input.firstName.trim();
  const email = input.email.trim().toLowerCase();
  if (!firstName) throw new DomainError("invalid", "Please enter your name.");
  if (!EMAIL.test(email) || email.length > 254) throw new DomainError("invalid", "Please enter a valid email address so we can confirm with you.");
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const day = ymdIn(input.startsAt, tz);

  const made = ctx.db.transaction(() => {
    const offered = availableSlots(ctx, s, day, day)[day] ?? [];
    const slot = offered.find((o) => o.startsAt === input.startsAt);
    if (!slot) throw new DomainError("taken", "Sorry, that time was just taken. Please pick another.", 409);
    const res = createLead(ctx, {
      contact: { firstName, lastName: input.lastName?.trim() ?? "", email, phone: input.phone?.trim() || null, source: `Booking page: ${s.name}` },
      shootTypeId: s.shootTypeId,
      source: `Booking page: ${s.name}`,
      message: input.message,
      eventDate: day,
    });
    const status = s.approval === "auto" ? ("confirmed" as const) : ("pending" as const);
    const name = displayName({ firstName, lastName: input.lastName ?? "", email });
    const entryId = newId();
    ctx.db
      .insert(calendarEntry)
      .values({ id: entryId, kind: "appointment", title: `${status === "pending" ? "Pending: " : ""}${s.name}: ${name}`, startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt), location: s.location, contactId: res.lead.contactId })
      .run();
    const id = newId();
    const token = crypto.randomBytes(24).toString("base64url");
    ctx.db.insert(schedulerBooking).values({ id, schedulerId: s.id, contactId: res.lead.contactId, leadId: res.lead.id, entryId, startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt), status, message: input.message?.trim().slice(0, 2000) || null, token }).run();
    return { id, token, status, contactId: res.lead.contactId, leadId: res.lead.id, slot, name };
  });

  const studio = ctx.settings.get("studio.name") || "the studio";
  const when = formatWhen(made.slot.startsAt, tz);
  const cancelUrl = linkTo(ctx, `/book/cancel/${made.token}`);
  const lines =
    made.status === "confirmed"
      ? [`Hi ${firstName},`, `You're booked: ${s.name} on ${when}.`, ...(s.location ? [`Where: ${s.location}`] : [])]
      : [`Hi ${firstName},`, `Thanks for asking to book ${s.name} on ${when}. I'll confirm it by email shortly. Until then the time is held for you.`];
  const mail = composeEmail(studio, lines, { label: "Need to cancel?", url: cancelUrl });
  queueEmail(ctx, { to: email, toName: made.name, subject: made.status === "confirmed" ? `You're booked: ${s.name}` : `Booking request received: ${s.name}`, text: mail.text, html: mail.html, kind: made.status === "confirmed" ? "booking.confirmed" : "booking.requested", contactId: made.contactId });
  const owner = ctx.settings.get("studio.email");
  if (owner) {
    const note = composeEmail(studio, [`${made.status === "confirmed" ? "New booking" : "New booking request"}: ${made.name} for ${s.name}, ${when}.`, input.message ? `Their message:\n${input.message.trim().slice(0, 2000)}` : ""].filter(Boolean), { label: made.status === "pending" ? "Review the request" : "Open bookings", url: linkTo(ctx, "/studio/booking") });
    queueEmail(ctx, { to: owner, subject: `${made.status === "confirmed" ? "Booked" : "Booking request"}: ${made.name}, ${s.name}`, text: note.text, html: note.html, kind: "booking.notify" });
  }
  return { id: made.id, status: made.status, startsAt: made.slot.startsAt, endsAt: made.slot.endsAt, cancelToken: made.token, when };
}

const bookingSelect = {
  id: schedulerBooking.id,
  status: schedulerBooking.status,
  startsAt: schedulerBooking.startsAt,
  endsAt: schedulerBooking.endsAt,
  message: schedulerBooking.message,
  createdAt: schedulerBooking.createdAt,
  leadId: schedulerBooking.leadId,
  contactId: contact.id,
  firstName: contact.firstName,
  lastName: contact.lastName,
  company: contact.company,
  email: contact.email,
  phone: contact.phone,
  schedulerId: scheduler.id,
  schedulerName: scheduler.name,
  location: scheduler.location,
};

export function listBookings(ctx: ServiceContext, filter: { status?: "pending" | "confirmed" | "declined" | "cancelled"; upcomingOnly?: boolean } = {}) {
  const conds = [];
  if (filter.status) conds.push(eq(schedulerBooking.status, filter.status));
  if (filter.upcomingOnly) conds.push(gt(schedulerBooking.endsAt, new Date()));
  return ctx.db
    .select(bookingSelect)
    .from(schedulerBooking)
    .innerJoin(contact, eq(contact.id, schedulerBooking.contactId))
    .innerJoin(scheduler, eq(scheduler.id, schedulerBooking.schedulerId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(filter.status === "pending" || filter.upcomingOnly ? asc(schedulerBooking.startsAt) : desc(schedulerBooking.startsAt))
    .limit(200)
    .all()
    .map((r) => ({ ...r, name: displayName(r) }));
}

function bookingRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(schedulerBooking).where(eq(schedulerBooking.id, id)).get();
  if (!row) throw notFound("Booking");
  return row;
}

function tell(ctx: ServiceContext, b: typeof schedulerBooking.$inferSelect, subject: (name: string) => string, lines: (when: string, name: string) => string[], kind: string, withCancel = false) {
  const c = ctx.db.select().from(contact).where(eq(contact.id, b.contactId)).get();
  const s = ctx.db.select().from(scheduler).where(eq(scheduler.id, b.schedulerId)).get();
  if (!c?.email || !s) return;
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const studio = ctx.settings.get("studio.name") || "the studio";
  const mail = composeEmail(studio, [`Hi ${c.firstName || "there"},`, ...lines(formatWhen(b.startsAt.getTime(), tz), s.name)], withCancel ? { label: "Need to cancel?", url: linkTo(ctx, `/book/cancel/${b.token}`) } : undefined);
  queueEmail(ctx, { to: c.email, toName: displayName(c), subject: subject(s.name), text: mail.text, html: mail.html, kind, contactId: c.id });
}

function setCalendar(ctx: ServiceContext, b: typeof schedulerBooking.$inferSelect, title?: string) {
  if (!b.entryId) return;
  if (title) ctx.db.update(calendarEntry).set({ title }).where(eq(calendarEntry.id, b.entryId)).run();
  else ctx.db.delete(calendarEntry).where(eq(calendarEntry.id, b.entryId)).run();
}

export function confirmBooking(ctx: ServiceContext, id: string) {
  const b = bookingRow(ctx, id);
  if (b.status !== "pending") throw new DomainError("invalid", "Only a waiting request can be confirmed.");
  ctx.db.update(schedulerBooking).set({ status: "confirmed" }).where(eq(schedulerBooking.id, id)).run();
  if (b.entryId) {
    const e = ctx.db.select().from(calendarEntry).where(eq(calendarEntry.id, b.entryId)).get();
    if (e) setCalendar(ctx, b, e.title.replace(/^Pending: /, ""));
  }
  tell(ctx, b, (n) => `You're booked: ${n}`, (when, n) => [`You're confirmed for ${n} on ${when}.`], "booking.confirmed", true);
  return listBookings(ctx).find((x) => x.id === id)!;
}

export function declineBooking(ctx: ServiceContext, id: string, reason?: string) {
  const b = bookingRow(ctx, id);
  if (b.status !== "pending") throw new DomainError("invalid", "Only a waiting request can be declined.");
  ctx.db.update(schedulerBooking).set({ status: "declined" }).where(eq(schedulerBooking.id, id)).run();
  setCalendar(ctx, b);
  tell(ctx, b, (n) => `About your request: ${n}`, (when, n) => [`I'm sorry, I can't do ${n} on ${when}.`, ...(reason?.trim() ? [reason.trim().slice(0, 1000)] : []), "Please pick another time and I'll do my best to fit you in."], "booking.declined");
  return { ok: true };
}

/** The owner cancels a booking that was confirmed (or still waiting). */
export function cancelBooking(ctx: ServiceContext, id: string, reason?: string) {
  const b = bookingRow(ctx, id);
  if (b.status === "cancelled" || b.status === "declined") return { ok: true };
  ctx.db.update(schedulerBooking).set({ status: "cancelled" }).where(eq(schedulerBooking.id, id)).run();
  setCalendar(ctx, b);
  tell(ctx, b, (n) => `Cancelled: ${n}`, (when, n) => [`Your ${n} on ${when} has been cancelled.`, ...(reason?.trim() ? [reason.trim().slice(0, 1000)] : [])], "booking.cancelled");
  return { ok: true };
}

/** The client cancels from the link in their email. Shows what it is first, and the owner is told. */
export function bookingByToken(ctx: ServiceContext, token: string) {
  const b = ctx.db.select().from(schedulerBooking).where(eq(schedulerBooking.token, token)).get();
  if (!b) throw notFound("Booking");
  const s = ctx.db.select().from(scheduler).where(eq(scheduler.id, b.schedulerId)).get()!;
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  return { name: s.name, status: b.status, when: formatWhen(b.startsAt.getTime(), tz), startsAt: b.startsAt.getTime(), past: b.startsAt.getTime() < Date.now(), studioName: ctx.settings.get("studio.name") ?? "" };
}

export function cancelByToken(ctx: ServiceContext, token: string) {
  const b = ctx.db.select().from(schedulerBooking).where(eq(schedulerBooking.token, token)).get();
  if (!b) throw notFound("Booking");
  if (b.status === "cancelled" || b.status === "declined") return bookingByToken(ctx, token);
  if (b.startsAt.getTime() < Date.now()) throw new DomainError("past", "That time has already passed.");
  ctx.db.update(schedulerBooking).set({ status: "cancelled" }).where(eq(schedulerBooking.id, b.id)).run();
  setCalendar(ctx, b);
  const owner = ctx.settings.get("studio.email");
  const c = ctx.db.select().from(contact).where(eq(contact.id, b.contactId)).get();
  const s = ctx.db.select().from(scheduler).where(eq(scheduler.id, b.schedulerId)).get();
  if (owner && c && s) {
    const tz = ctx.settings.get("studio.timezone") ?? "UTC";
    const mail = composeEmail(ctx.settings.get("studio.name") || "the studio", [`${displayName(c)} cancelled ${s.name} on ${formatWhen(b.startsAt.getTime(), tz)}. The time is free again.`]);
    queueEmail(ctx, { to: owner, subject: `Cancelled: ${displayName(c)}, ${s.name}`, text: mail.text, html: mail.html, kind: "booking.cancelled.owner" });
  }
  return bookingByToken(ctx, token);
}
