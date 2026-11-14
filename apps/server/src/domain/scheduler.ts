import crypto from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { busyIntervals } from "./calendar.js";
import { assertBookingTemplate, createContract, markSent } from "./contracts.js";
import { displayName } from "./contacts.js";
import { DomainError, linkTo, newId, notFound, type ServiceContext } from "./context.js";
import { evaluate as evaluateCoupon } from "./coupons.js";
import { composeEmail, queueEmail } from "./email.js";
import { convertLead, createLead } from "./leads.js";
import { updateShoot } from "./shoots.js";
import { formatMoney, totalsFor } from "./money.js";
import { createOrder, paidOf, voidOrder } from "./orders.js";
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
  /** What the session costs, in cents. Zero or omitted means free to book. */
  priceCents?: number;
  depositType?: "none" | "percent" | "fixed";
  /** Percent: basis points (2500 = 25%). Fixed: cents. */
  depositValue?: number;
  /** A contract template the client signs before paying. Needs a price. */
  contractTemplateId?: string | null;
  /** Make a shoot when a booking is confirmed. Needs a shoot type. */
  createShoot?: boolean;
  /** Most bookings in one day. Zero or omitted means no limit. */
  maxPerDay?: number;
  /** Special dates (YYYY-MM-DD) that replace the weekly hours. An empty list closes that day. */
  dateOverrides?: Availability;
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

/** Cleans special dates: real dates, valid hours, at most 400 of them. A date with no hours is a closed day. */
export function cleanOverrides(input: Availability): Availability {
  const out: Availability = {};
  const entries = Object.entries(input);
  if (entries.length > 400) throw new DomainError("invalid", "That's too many special dates. Remove some that have passed.");
  for (const [date, windows] of entries) {
    if (!isYmd(date)) throw new DomainError("invalid", `${date} isn't a valid date.`);
    // The same checks as weekly hours, using day 0 as a stand-in.
    out[date] = cleanAvailability({ "0": windows })["0"] ?? [];
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
  const priceCents = int(input.priceCents, 0, 0, 100_000_000, "The price");
  const depositType = priceCents > 0 ? (input.depositType ?? "none") : "none";
  const depositValue = depositType === "none" ? 0 : int(input.depositValue, 0, 1, depositType === "percent" ? 10_000 : priceCents, depositType === "percent" ? "The retainer percentage" : "The retainer");
  const createShoot = input.createShoot ?? false;
  if (createShoot && !input.shootTypeId) throw new DomainError("invalid", "Choose a shoot type to make shoots from bookings.");
  const maxPerDay = int(input.maxPerDay, 0, 0, 100, "The daily limit");
  const contractTemplateId = input.contractTemplateId || null;
  if (contractTemplateId) {
    if (priceCents <= 0) throw new DomainError("invalid", "A contract is signed before paying, so give this page a price first.");
    assertBookingTemplate(ctx, contractTemplateId);
  }
  return {
    createShoot,
    maxPerDay,
    dateOverrides: cleanOverrides(input.dateOverrides ?? {}),
    contractTemplateId,
    priceCents,
    depositType,
    depositValue,
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
  // How many bookings each day already holds, for pages with a daily limit.
  const taken: Record<string, number> = {};
  if (s.maxPerDay > 0) {
    const rows = ctx.db
      .select({ startsAt: schedulerBooking.startsAt })
      .from(schedulerBooking)
      .where(and(eq(schedulerBooking.schedulerId, s.id), inArray(schedulerBooking.status, ["pending", "confirmed"]), gte(schedulerBooking.startsAt, new Date(atTime(from, "00:00", tz))), lt(schedulerBooking.startsAt, new Date(atTime(addDays(to, 1), "00:00", tz)))))
      .all();
    for (const r of rows) {
      const d = ymdIn(r.startsAt.getTime(), tz);
      taken[d] = (taken[d] ?? 0) + 1;
    }
  }
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const slots: Slot[] = [];
    if (s.maxPerDay > 0 && (taken[day] ?? 0) >= s.maxPerDay) continue;
    for (const w of s.dateOverrides[day] ?? s.availability[String(weekdayOf(day))] ?? []) {
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
  /** A coupon code for a page that charges. */
  couponCode?: string;
}

/** What a visitor owes for a page that charges, with an optional coupon, before anything is booked. */
export function priceFor(ctx: ServiceContext, s: typeof scheduler.$inferSelect, rawCode?: string | null) {
  if (s.priceCents <= 0) return null;
  const lines = [{ itemId: null, quantity: 1, unitCents: s.priceCents, taxable: true }];
  const coupon = rawCode?.trim() ? evaluateCoupon(ctx, rawCode, lines, { manualDiscountCents: 0, schedulerId: s.id }) : null;
  const totals = totalsFor(lines, coupon?.cents ?? 0, ctx.settings.get("money.taxBps") ?? 0);
  const asked = s.depositType === "percent" ? Math.round((totals.totalCents * s.depositValue) / 10_000) : s.depositType === "fixed" ? s.depositValue : 0;
  // A retainer is never more than the total; one that covers everything just means paying in full.
  const depositCents = Math.min(asked, totals.totalCents);
  const cur = ctx.settings.get("money.currency") || "USD";
  return {
    currency: cur,
    priceCents: s.priceCents,
    couponCode: coupon?.code ?? null,
    couponCents: coupon?.cents ?? 0,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    depositCents,
    balanceCents: totals.totalCents - depositCents,
    summary: depositCents > 0 && depositCents < totals.totalCents ? `${formatMoney(depositCents, cur)} retainer now, ${formatMoney(totals.totalCents - depositCents, cur)} later` : formatMoney(totals.totalCents, cur),
  };
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
  // Check the coupon before the time is held, so a typo never costs anyone a slot.
  const price = priceFor(ctx, s, input.couponCode);

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

  const invoice = price ? raiseInvoice(ctx, s, made, price, day, input.couponCode) : null;
  if (made.status === "confirmed") bookAsShoot(ctx, made.id);
  const agreement = invoice && s.contractTemplateId ? requestContract(ctx, s.contractTemplateId, made.contactId, invoice.id) : null;
  const studio = ctx.settings.get("studio.name") || "the studio";
  const when = formatWhen(made.slot.startsAt, tz);
  const cancelUrl = linkTo(ctx, `/book/cancel/${made.token}`);
  const lines =
    made.status === "confirmed"
      ? [`Hi ${firstName},`, `You're booked: ${s.name} on ${when}.`, ...(s.location ? [`Where: ${s.location}`] : [])]
      : [`Hi ${firstName},`, `Thanks for asking to book ${s.name} on ${when}. I'll confirm it by email shortly. Until then the time is held for you.`];
  if (agreement) lines.push(`Please review and sign your agreement first: ${agreement.url}`, "Once it's signed you can pay online.");
  if (invoice && price) lines.push(price.depositCents > 0 && price.depositCents < price.totalCents ? `A ${formatMoney(price.depositCents, price.currency)} retainer is due to hold your time, and ${formatMoney(price.balanceCents, price.currency)} after that. You can pay it here: ${invoice.url}` : `The total is ${formatMoney(price.totalCents, price.currency)}. You can pay it here: ${invoice.url}`);
  const mail = composeEmail(studio, lines, { label: "Need to cancel?", url: cancelUrl });
  queueEmail(ctx, { to: email, toName: made.name, subject: made.status === "confirmed" ? `You're booked: ${s.name}` : `Booking request received: ${s.name}`, text: mail.text, html: mail.html, kind: made.status === "confirmed" ? "booking.confirmed" : "booking.requested", contactId: made.contactId });
  const owner = ctx.settings.get("studio.email");
  if (owner) {
    const note = composeEmail(studio, [`${made.status === "confirmed" ? "New booking" : "New booking request"}: ${made.name} for ${s.name}, ${when}.`, input.message ? `Their message:\n${input.message.trim().slice(0, 2000)}` : ""].filter(Boolean), { label: made.status === "pending" ? "Review the request" : "Open bookings", url: linkTo(ctx, "/studio/booking") });
    queueEmail(ctx, { to: owner, subject: `${made.status === "confirmed" ? "Booked" : "Booking request"}: ${made.name}, ${s.name}`, text: note.text, html: note.html, kind: "booking.notify" });
  }
  return { id: made.id, status: made.status, startsAt: made.slot.startsAt, endsAt: made.slot.endsAt, cancelToken: made.token, when, invoice: invoice ? { token: invoice.token, totalCents: price!.totalCents, depositCents: price!.depositCents, currency: price!.currency, contractUrl: agreement?.url ?? null } : null };
}

/**
 * A page that charges gets an invoice the moment someone books, with the retainer as its first payment and the balance
 * due on the day. It is the same invoice clients pay everywhere else, so PayPal, credit and manual payments all work.
 */
function raiseInvoice(ctx: ServiceContext, s: typeof scheduler.$inferSelect, made: { id: string; contactId: string; leadId: string; name: string }, price: NonNullable<ReturnType<typeof priceFor>>, day: string, couponCode?: string) {
  const full = price.depositCents <= 0 || price.depositCents >= price.totalCents;
  const inv = createOrder(ctx, "invoice", {
    contactId: made.contactId,
    leadId: made.leadId,
    title: s.name,
    schedulerId: s.id,
    couponCode: couponCode?.trim() || null,
    lines: [{ description: s.name, unitCents: s.priceCents }],
    schedule: full ? undefined : [{ label: "Retainer", amountCents: price.depositCents, dueDate: null }, { label: "Balance", amountCents: price.balanceCents, dueDate: day }],
  });
  ctx.db.update(tables.order).set({ status: "sent", sentAt: new Date() }).where(eq(tables.order.id, inv.id)).run();
  ctx.db.update(schedulerBooking).set({ orderId: inv.id }).where(eq(schedulerBooking.id, made.id)).run();
  return { id: inv.id, token: inv.token, url: linkTo(ctx, `/o/${inv.token}`) };
}

/**
 * When the page asks for it, a confirmed booking becomes a shoot with one event at the booked time. The calendar then shows
 * the shoot's event instead of the appointment, so the time isn't listed twice. Never fails the booking itself.
 */
function bookAsShoot(ctx: ServiceContext, bookingId: string) {
  const b = ctx.db.select().from(schedulerBooking).where(eq(schedulerBooking.id, bookingId)).get();
  if (!b || b.shootId || !b.leadId) return;
  const s = ctx.db.select().from(scheduler).where(eq(scheduler.id, b.schedulerId)).get();
  if (!s?.createShoot || !s.shootTypeId) return;
  try {
    const made = convertLead(ctx, b.leadId, { events: [{ title: s.name, startsAt: b.startsAt.getTime(), endsAt: b.endsAt.getTime(), location: s.location }] });
    if (b.entryId) ctx.db.delete(calendarEntry).where(eq(calendarEntry.id, b.entryId)).run();
    ctx.db.update(schedulerBooking).set({ shootId: made.shoot.id, entryId: null }).where(eq(schedulerBooking.id, b.id)).run();
  } catch {
    /* The lead was already booked by hand, or the type was archived: the booking stands without a shoot. */
  }
}

/** A booking that fell through takes its shoot with it. */
function cancelShoot(ctx: ServiceContext, b: typeof schedulerBooking.$inferSelect) {
  if (!b.shootId) return;
  try {
    updateShoot(ctx, b.shootId, { status: "cancelled" });
  } catch {
    /* already gone */
  }
}

/** Drafts the page's agreement for this client, sends it, and holds online payment until it is signed. */
function requestContract(ctx: ServiceContext, templateId: string, contactId: string, orderId: string) {
  const made = createContract(ctx, { templateId, contactId, orderId });
  ctx.db.update(tables.order).set({ requiredContractId: made.id }).where(eq(tables.order.id, orderId)).run();
  // The booking email carries the link, so the contract's own email isn't sent as well.
  markSent(ctx, made.id);
  return { id: made.id, url: made.link };
}

/** When a booking falls through, an invoice nobody paid is voided so it doesn't linger. A paid one is left for the studio to refund. */
function releaseInvoice(ctx: ServiceContext, b: typeof schedulerBooking.$inferSelect) {
  if (!b.orderId) return;
  try {
    voidOrder(ctx, b.orderId);
  } catch {
    /* payments were taken: the studio decides whether to refund */
  }
}

const bookingSelect = {
  id: schedulerBooking.id,
  status: schedulerBooking.status,
  startsAt: schedulerBooking.startsAt,
  endsAt: schedulerBooking.endsAt,
  message: schedulerBooking.message,
  createdAt: schedulerBooking.createdAt,
  leadId: schedulerBooking.leadId,
  orderId: schedulerBooking.orderId,
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
    .map((r) => ({ ...r, name: displayName(r), payment: paymentOf(ctx, r.orderId) }));
}

/** Where a paid booking's invoice stands, for the bookings list. */
function paymentOf(ctx: ServiceContext, orderId: string | null) {
  if (!orderId) return null;
  const o = ctx.db.select({ totalCents: tables.order.totalCents, status: tables.order.status }).from(tables.order).where(eq(tables.order.id, orderId)).get();
  if (!o) return null;
  const paidCents = paidOf(ctx, orderId);
  return { totalCents: o.totalCents, paidCents, status: o.status === "void" ? ("void" as const) : paidCents <= 0 ? ("unpaid" as const) : paidCents >= o.totalCents ? ("paid" as const) : ("partial" as const) };
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
  bookAsShoot(ctx, id);
  if (b.entryId && !ctx.db.select({ s: schedulerBooking.shootId }).from(schedulerBooking).where(eq(schedulerBooking.id, id)).get()?.s) {
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
  cancelShoot(ctx, b);
  releaseInvoice(ctx, b);
  tell(ctx, b, (n) => `About your request: ${n}`, (when, n) => [`I'm sorry, I can't do ${n} on ${when}.`, ...(reason?.trim() ? [reason.trim().slice(0, 1000)] : []), "Please pick another time and I'll do my best to fit you in."], "booking.declined");
  return { ok: true };
}

/** The owner cancels a booking that was confirmed (or still waiting). */
export function cancelBooking(ctx: ServiceContext, id: string, reason?: string) {
  const b = bookingRow(ctx, id);
  if (b.status === "cancelled" || b.status === "declined") return { ok: true };
  ctx.db.update(schedulerBooking).set({ status: "cancelled" }).where(eq(schedulerBooking.id, id)).run();
  setCalendar(ctx, b);
  cancelShoot(ctx, b);
  releaseInvoice(ctx, b);
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
  cancelShoot(ctx, b);
  releaseInvoice(ctx, b);
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
