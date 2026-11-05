import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { reminders } from "../automation/queue.js";
import type { AppContext } from "../app.js";
import { listCalendar, type CalendarItem } from "./calendar.js";
import { displayName } from "./contacts.js";
import type { ServiceContext } from "./context.js";
import { listIncoming } from "./incoming.js";
import { openLeadCount } from "./leads.js";
import { startOfDay, ymdIn } from "./time.js";

const { lead, leadStage, contact, shoot, shootEvent, order, payment, paymentSchedule, contract, questionnaire, gallery, photo } = tables;

const DAY = 86_400_000;

/** How far along the paperwork for a shoot is. Shown on each row of the agenda. */
export interface Readiness {
  contract: "signed" | "sent" | "none";
  deposit: "paid" | "due" | "none";
  questionnaire: "returned" | "sent" | "none";
}

export type UpcomingItem = CalendarItem & { readiness?: Readiness };

export interface NeedItem {
  key: "inquiries" | "quiet-leads" | "overdue" | "contracts" | "galleries" | "incoming" | "approvals" | "shoot-prep";
  count: number;
  title: string;
  detail: string;
  /** Where the row goes, inside the app. */
  to: string;
  /** What to call the button. */
  action: string;
  tone: "accent" | "bad" | "warn" | "info" | "neutral";
  /** When the oldest item started waiting (ms), for sorting. */
  since: number;
}

export interface HomeSummary {
  pulse: {
    openLeads: number;
    newLeadsThisWeek: number;
    /** Shoots with a date in the current calendar month, and the invoices attached to them. */
    monthShoots: number;
    monthBookedCents: number;
    outstandingCents: number;
    outstandingInvoices: number;
    overdueInvoices: number;
    galleriesToDeliver: number;
    galleriesDeliveredThisYear: number;
  };
  /** The next seven days, in start order. Busy blocks from other calendars are left out. */
  upcoming: UpcomingItem[];
  needs: NeedItem[];
  /** The cover of the most recently updated gallery that has one, for the hero band. */
  hero: { galleryId: string; title: string; preview: string; focalX: number; focalY: number } | null;
}

const tzOf = (ctx: ServiceContext) => ctx.settings.get("studio.timezone") ?? "UTC";

const days = (since: number, now: number) => Math.max(0, Math.floor((now - since) / DAY));
/** "today", "1 day ago", "6 days ago". */
const ago = (since: number, now: number) => {
  const d = days(since, now);
  return d < 1 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Money received per order, refunds already subtracted. */
function paidByOrder(ctx: ServiceContext, orderIds: string[]): Map<string, number> {
  if (!orderIds.length) return new Map();
  return new Map(
    ctx.db
      .select({ orderId: payment.orderId, n: sql<number>`coalesce(sum(${payment.amountCents}), 0)` })
      .from(payment)
      .where(inArray(payment.orderId, orderIds))
      .groupBy(payment.orderId)
      .all()
      .map((r) => [r.orderId, r.n]),
  );
}

function readinessFor(ctx: ServiceContext, shootIds: string[]): Map<string, Readiness> {
  const out = new Map<string, Readiness>();
  if (!shootIds.length) return out;
  for (const id of shootIds) out.set(id, { contract: "none", deposit: "none", questionnaire: "none" });
  const rank = { signed: 2, sent: 1, none: 0, returned: 2, paid: 2, due: 1 } as const;
  const bump = <K extends keyof Readiness>(id: string, key: K, value: Readiness[K]) => {
    const r = out.get(id)!;
    if (rank[value] > rank[r[key]]) r[key] = value;
  };
  for (const c of ctx.db.select({ shootId: contract.shootId, status: contract.status }).from(contract).where(inArray(contract.shootId, shootIds)).all()) {
    if (c.status === "signed") bump(c.shootId!, "contract", "signed");
    else if (c.status === "sent") bump(c.shootId!, "contract", "sent");
  }
  for (const q of ctx.db.select({ shootId: questionnaire.shootId, status: questionnaire.status }).from(questionnaire).where(inArray(questionnaire.shootId, shootIds)).all()) {
    if (q.status === "submitted") bump(q.shootId, "questionnaire", "returned");
    else if (q.status === "sent") bump(q.shootId, "questionnaire", "sent");
  }
  const invoices = ctx.db
    .select({ id: order.id, shootId: order.shootId })
    .from(order)
    .where(and(inArray(order.shootId, shootIds), eq(order.kind, "invoice"), eq(order.status, "sent")))
    .all();
  const paid = paidByOrder(ctx, invoices.map((i) => i.id));
  for (const inv of invoices) bump(inv.shootId!, "deposit", (paid.get(inv.id) ?? 0) > 0 ? "paid" : "due");
  return out;
}

function upcoming(ctx: ServiceContext, now: number): UpcomingItem[] {
  const tz = tzOf(ctx);
  const from = startOfDay(ymdIn(now, tz), tz);
  const items = listCalendar(ctx, from, from + 7 * DAY, { includeBusy: false });
  const ready = readinessFor(ctx, [...new Set(items.map((i) => i.shootId).filter((id): id is string => !!id))]);
  return items.slice(0, 20).map((i) => (i.shootId ? { ...i, readiness: ready.get(i.shootId) } : i));
}

function pulse(ctx: ServiceContext, now: number): HomeSummary["pulse"] {
  const tz = tzOf(ctx);
  const today = ymdIn(now, tz);
  const monthStart = startOfDay(`${today.slice(0, 7)}-01`, tz);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const monthEnd = startOfDay(nextMonth, tz);
  const yearStart = startOfDay(`${today.slice(0, 4)}-01-01`, tz);

  const newLeadsThisWeek = ctx.db.select({ n: count() }).from(lead).where(gte(lead.createdAt, new Date(now - 7 * DAY))).get()?.n ?? 0;

  const monthShootIds = ctx.db
    .selectDistinct({ id: shoot.id })
    .from(shootEvent)
    .innerJoin(shoot, eq(shoot.id, shootEvent.shootId))
    .where(and(gte(shootEvent.startsAt, new Date(monthStart)), lt(shootEvent.startsAt, new Date(monthEnd)), sql`${shoot.status} != 'cancelled'`))
    .all()
    .map((r) => r.id);
  const monthBookedCents = monthShootIds.length
    ? (ctx.db
        .select({ n: sql<number>`coalesce(sum(${order.totalCents}), 0)` })
        .from(order)
        .where(and(inArray(order.shootId, monthShootIds), eq(order.kind, "invoice"), eq(order.status, "sent")))
        .get()?.n ?? 0)
    : 0;

  const sent = ctx.db.select({ id: order.id, totalCents: order.totalCents }).from(order).where(and(eq(order.kind, "invoice"), eq(order.status, "sent"))).all();
  const paidMap = paidByOrder(ctx, sent.map((o) => o.id));
  const invoices = sent.map((o) => ({ ...o, paid: paidMap.get(o.id) ?? 0 })).filter((o) => o.totalCents - o.paid > 0);
  let overdueInvoices = 0;
  if (invoices.length) {
    const sched = ctx.db
      .select()
      .from(paymentSchedule)
      .where(
        inArray(
          paymentSchedule.orderId,
          invoices.map((i) => i.id),
        ),
      )
      .orderBy(asc(paymentSchedule.position))
      .all();
    for (const inv of invoices) {
      let left = inv.paid;
      let overdue = false;
      for (const s of sched.filter((r) => r.orderId === inv.id)) {
        const covered = Math.min(left, s.amountCents);
        left -= covered;
        if (covered < s.amountCents && s.dueDate && s.dueDate < today) overdue = true;
      }
      if (overdue) overdueInvoices++;
    }
  }

  const photoCounts = ctx.db
    .select({ galleryId: photo.galleryId, ready: sql<number>`sum(case when ${photo.state} = 'ready' then 1 else 0 end)`, pending: sql<number>`sum(case when ${photo.state} = 'pending' then 1 else 0 end)` })
    .from(photo)
    .groupBy(photo.galleryId)
    .all();
  const counts = new Map(photoCounts.map((r) => [r.galleryId, r]));
  const drafts = ctx.db.select({ id: gallery.id }).from(gallery).where(eq(gallery.status, "draft")).all();
  const galleriesToDeliver = drafts.filter((g) => (counts.get(g.id)?.ready ?? 0) > 0 && (counts.get(g.id)?.pending ?? 0) === 0).length;
  const galleriesDeliveredThisYear = ctx.db.select({ n: count() }).from(gallery).where(and(eq(gallery.status, "live"), gte(gallery.publishedAt, new Date(yearStart)))).get()?.n ?? 0;

  return {
    openLeads: openLeadCount(ctx),
    newLeadsThisWeek,
    monthShoots: monthShootIds.length,
    monthBookedCents,
    outstandingCents: invoices.reduce((n, o) => n + (o.totalCents - o.paid), 0),
    outstandingInvoices: invoices.length,
    overdueInvoices,
    galleriesToDeliver,
    galleriesDeliveredThisYear,
  };
}

function needs(ctx: ServiceContext, app: AppContext, now: number, p: HomeSummary["pulse"]): NeedItem[] {
  const out: NeedItem[] = [];

  // Inquiries still in the first stage, however new. The reminder list only counts those older than a day.
  const first = ctx.db.select().from(leadStage).where(eq(leadStage.kind, "open")).orderBy(asc(leadStage.position)).get();
  if (first) {
    const rows = ctx.db
      .select({ createdAt: lead.createdAt, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email, shootType: tables.shootType.name })
      .from(lead)
      .innerJoin(contact, eq(contact.id, lead.contactId))
      .leftJoin(tables.shootType, eq(tables.shootType.id, lead.shootTypeId))
      .where(and(eq(lead.stageId, first.id), isNull(lead.closedAt)))
      .orderBy(asc(lead.createdAt))
      .limit(50)
      .all();
    if (rows.length) {
      const oldest = rows[0]!;
      const who = oldest.shootType ? `${displayName(oldest)}, ${oldest.shootType.toLowerCase()}` : displayName(oldest);
      out.push({
        key: "inquiries",
        count: rows.length,
        title: rows.length === 1 ? "Inquiry waiting for a reply" : "Inquiries waiting for a reply",
        detail: rows.length === 1 ? `${who} · ${ago(oldest.createdAt.getTime(), now)}` : `Oldest arrived ${ago(oldest.createdAt.getTime(), now)}: ${who}`,
        to: "/studio/leads",
        action: "Reply",
        tone: "accent",
        since: oldest.createdAt.getTime(),
      });
    }
  }

  const rem = reminders(app);
  const quiet = rem.filter((r) => r.automation === "lead-follow-up");
  if (quiet.length) {
    out.push({ key: "quiet-leads", count: quiet.length, title: quiet.length === 1 ? "Lead gone quiet" : "Leads gone quiet", detail: quiet[0]!.detail, to: "/studio/leads", action: "Follow up", tone: "warn", since: quiet[0]!.since });
  }
  const prep = rem.filter((r) => r.automation === "shoot-prep");
  if (prep.length) {
    out.push({ key: "shoot-prep", count: prep.length, title: prep.length === 1 ? "Shoot needs preparing" : "Shoots need preparing", detail: prep[0]!.detail, to: `/studio/shoots/${prep[0]!.ref.id}`, action: "Prepare", tone: "warn", since: prep[0]!.since });
  }

  if (p.overdueInvoices) {
    const today = ymdIn(now, tzOf(ctx));
    const oldest = ctx.db
      .select({ orderId: paymentSchedule.orderId, dueDate: paymentSchedule.dueDate, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email })
      .from(paymentSchedule)
      .innerJoin(order, eq(order.id, paymentSchedule.orderId))
      .innerJoin(contact, eq(contact.id, order.contactId))
      .where(and(eq(order.kind, "invoice"), eq(order.status, "sent"), lt(paymentSchedule.dueDate, today)))
      .orderBy(asc(paymentSchedule.dueDate))
      .get();
    const since = oldest?.dueDate ? startOfDay(oldest.dueDate, tzOf(ctx)) : now;
    out.push({
      key: "overdue",
      count: p.overdueInvoices,
      title: p.overdueInvoices === 1 ? "Invoice overdue" : "Invoices overdue",
      detail: oldest ? `${displayName(oldest)} · due ${ago(since, now)}` : `${plural(p.overdueInvoices, "invoice")} past due`,
      to: "/studio/orders",
      action: "Remind",
      tone: "bad",
      since,
    });
  }

  const unsigned = ctx.db.select({ sentAt: contract.sentAt, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email }).from(contract).innerJoin(contact, eq(contact.id, contract.contactId)).where(eq(contract.status, "sent")).orderBy(asc(contract.sentAt)).all();
  if (unsigned.length) {
    const oldest = unsigned[0]!;
    const since = oldest.sentAt?.getTime() ?? now;
    out.push({
      key: "contracts",
      count: unsigned.length,
      title: unsigned.length === 1 ? "Contract unsigned" : "Contracts unsigned",
      detail: unsigned.length === 1 ? `${displayName(oldest)} · sent ${ago(since, now)}` : `Oldest sent ${ago(since, now)}: ${displayName(oldest)}`,
      to: "/studio/contracts",
      action: "Nudge",
      tone: "warn",
      since,
    });
  }

  if (p.galleriesToDeliver) {
    const ready = ctx.db
      .select({ id: gallery.id, title: gallery.title, updatedAt: gallery.updatedAt, n: sql<number>`(select count(*) from ${photo} where ${photo.galleryId} = ${gallery.id} and ${photo.state} = 'ready')` })
      .from(gallery)
      .where(eq(gallery.status, "draft"))
      .orderBy(asc(gallery.updatedAt))
      .all()
      .filter((g) => g.n > 0);
    const oldest = ready[0];
    if (oldest)
      out.push({
        key: "galleries",
        count: p.galleriesToDeliver,
        title: p.galleriesToDeliver === 1 ? "Gallery ready to share" : "Galleries ready to share",
        detail: p.galleriesToDeliver === 1 ? `${oldest.title} · ${plural(oldest.n, "photo")}` : `${oldest.title} and ${p.galleriesToDeliver - 1} more`,
        to: p.galleriesToDeliver === 1 ? `/studio/galleries/${oldest.id}` : "/studio/galleries",
        action: "Share",
        tone: "info",
        since: oldest.updatedAt.getTime(),
      });
  }

  const incoming = listIncoming(ctx, now).total;
  if (incoming) {
    out.push({ key: "incoming", count: incoming, title: `${plural(incoming, "photo")} in Incoming`, detail: "From a camera or an export, not yet in a shoot.", to: "/studio/incoming", action: "Sort", tone: "neutral", since: now });
  }

  const approvals = app.db.select({ n: count(), since: sql<number>`min(${tables.aiApproval.createdAt})` }).from(tables.aiApproval).where(eq(tables.aiApproval.status, "pending")).get();
  if (approvals?.n) {
    out.push({ key: "approvals", count: approvals.n, title: approvals.n === 1 ? "AI approval waiting" : "AI approvals waiting", detail: "Your assistant wants to act and is waiting on you.", to: "/studio/approvals", action: "Review", tone: "accent", since: Number(approvals.since) || now });
  }

  return out;
}

function hero(ctx: ServiceContext, mediaUrl: (p: typeof photo.$inferSelect) => string): HomeSummary["hero"] {
  const rows = ctx.db.select().from(gallery).where(sql`${gallery.coverPhotoId} is not null and ${gallery.status} != 'archived'`).orderBy(desc(gallery.updatedAt)).limit(5).all();
  for (const g of rows) {
    const p = ctx.db.select().from(photo).where(eq(photo.id, g.coverPhotoId!)).get();
    if (p && p.state === "ready") return { galleryId: g.id, title: g.title, preview: mediaUrl(p), focalX: g.coverFocalX, focalY: g.coverFocalY };
  }
  return null;
}

/** Everything the home page shows in one call. Owner only: it totals the studio's money. */
export function homeSummary(ctx: ServiceContext, app: AppContext, mediaUrl: (p: typeof photo.$inferSelect) => string, now = Date.now()): HomeSummary {
  const p = pulse(ctx, now);
  return { pulse: p, upcoming: upcoming(ctx, now), needs: needs(ctx, app, now, p).sort((a, b) => a.since - b.since), hero: hero(ctx, mediaUrl) };
}
