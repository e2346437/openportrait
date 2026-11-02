import { eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, type ServiceContext } from "./context.js";
import { paidOf } from "./orders.js";
import { addDays, isYmd, startOfDay, ymdIn } from "./time.js";

const { order, payment, shoot, shootType } = tables;

export interface ReportRange {
  from: string;
  to: string;
}

export interface MonthRow {
  month: string;
  invoicedCents: number;
  collectedCents: number;
  refundedCents: number;
}

export interface OutstandingRow {
  id: string;
  label: string;
  title: string;
  contactId: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /** The date the invoice was issued (YYYY-MM-DD). */
  issuedOn: string;
  /** The earliest unpaid installment's due date, or null when nothing has a date. */
  dueOn: string | null;
  daysOverdue: number;
}

export interface FinancialReport {
  range: ReportRange;
  currency: string;
  totals: {
    invoicedCents: number;
    taxInvoicedCents: number;
    collectedCents: number;
    refundedCents: number;
    netCollectedCents: number;
    invoiceCount: number;
    paymentCount: number;
    averageInvoiceCents: number;
  };
  /** What is owed right now, whatever the range. */
  outstanding: { totalCents: number; overdueCents: number; count: number; rows: OutstandingRow[] };
  byMonth: MonthRow[];
  byMethod: Array<{ method: string; cents: number; count: number }>;
  byShootType: Array<{ id: string | null; name: string; invoicedCents: number; collectedCents: number; invoiceCount: number }>;
}

const MAX_DAYS = 3660;
const monthOf = (ymd: string) => ymd.slice(0, 7);

/** The first and last day of the month `ymd` falls in. */
export const monthRange = (ymd: string): ReportRange => {
  const [y, m] = ymd.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${monthOf(ymd)}-01`, to: `${monthOf(ymd)}-${String(last).padStart(2, "0")}` };
};

/** Validates a range from the query string. Defaults to the year so far in the studio's time zone. */
export function resolveRange(ctx: ServiceContext, from?: string, to?: string): ReportRange {
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const today = ymdIn(Date.now(), tz);
  const range = { from: from || `${today.slice(0, 4)}-01-01`, to: to || today };
  if (!isYmd(range.from) || !isYmd(range.to)) throw new DomainError("invalid", "Use dates like 2026-01-31.");
  if (range.from > range.to) throw new DomainError("invalid", "The start date is after the end date.");
  if ((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 > MAX_DAYS) throw new DomainError("invalid", "Choose a range of ten years or less.");
  return range;
}

function monthsBetween(range: ReportRange): string[] {
  const out: string[] = [];
  let [y, m] = range.from.split("-").map(Number) as [number, number];
  const [ey, em] = range.to.split("-").map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * Income and receivables for the range. Collected money counts on the day the payment was received (cash basis), so a
 * refund lowers the month it was paid out in. Invoiced counts on the day an invoice was issued: when a client accepted
 * the quote it came from, otherwise when it was sent or created. Drafts and void invoices never count.
 */
export function financialReport(ctx: ServiceContext, range: ReportRange): FinancialReport {
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const today = ymdIn(Date.now(), tz);
  const startMs = startOfDay(range.from, tz);
  const endMs = startOfDay(addDays(range.to, 1), tz);

  const types = new Map(ctx.db.select().from(shootType).all().map((t) => [t.id, t.name]));
  const shootTypeOf = new Map(ctx.db.select({ id: shoot.id, typeId: shoot.shootTypeId }).from(shoot).all().map((s) => [s.id, s.typeId]));
  const typeOfOrder = (shootId: string | null) => (shootId ? (shootTypeOf.get(shootId) ?? null) : null);

  const invoices = ctx.db.select().from(order).where(eq(order.kind, "invoice")).all().filter((o) => o.status !== "draft" && o.status !== "void");
  const byId = new Map(invoices.map((o) => [o.id, o]));

  const months = new Map(monthsBetween(range).map((m) => [m, { month: m, invoicedCents: 0, collectedCents: 0, refundedCents: 0 } as MonthRow]));
  const methods = new Map<string, { cents: number; count: number }>();
  const typeRows = new Map<string | null, { id: string | null; name: string; invoicedCents: number; collectedCents: number; invoiceCount: number }>();
  const typeRow = (id: string | null) => {
    let r = typeRows.get(id);
    if (!r) {
      r = { id, name: id ? (types.get(id) ?? "Removed type") : "No shoot linked", invoicedCents: 0, collectedCents: 0, invoiceCount: 0 };
      typeRows.set(id, r);
    }
    return r;
  };

  let invoiced = 0;
  let tax = 0;
  let invoiceCount = 0;
  for (const o of invoices) {
    const issuedMs = (o.acceptedAt ?? o.sentAt ?? o.createdAt).getTime();
    if (issuedMs < startMs || issuedMs >= endMs) continue;
    invoiced += o.totalCents;
    tax += o.taxCents;
    invoiceCount++;
    const m = months.get(monthOf(ymdIn(issuedMs, tz)));
    if (m) m.invoicedCents += o.totalCents;
    const t = typeRow(typeOfOrder(o.shootId));
    t.invoicedCents += o.totalCents;
    t.invoiceCount++;
  }

  let collected = 0;
  let refunded = 0;
  let paymentCount = 0;
  const pays = ctx.db.select().from(payment).all();
  for (const p of pays) {
    const ms = p.paidAt.getTime();
    if (ms < startMs || ms >= endMs) continue;
    const inv = byId.get(p.orderId);
    // A payment against a voided invoice is still money that moved, so it counts; it just has no shoot type to credit.
    const m = months.get(monthOf(ymdIn(ms, tz)));
    if (p.amountCents >= 0) {
      collected += p.amountCents;
      paymentCount++;
      if (m) m.collectedCents += p.amountCents;
      const k = methods.get(p.method) ?? { cents: 0, count: 0 };
      k.cents += p.amountCents;
      k.count++;
      methods.set(p.method, k);
    } else {
      refunded += -p.amountCents;
      if (m) m.refundedCents += -p.amountCents;
      const k = methods.get(p.method) ?? { cents: 0, count: 0 };
      k.cents += p.amountCents;
      methods.set(p.method, k);
    }
    typeRow(inv ? typeOfOrder(inv.shootId) : null).collectedCents += p.amountCents;
  }

  // Receivables are a picture of today, not of the range.
  const rows: OutstandingRow[] = [];
  for (const o of invoices) {
    const paid = paidOf(ctx, o.id);
    const balance = o.totalCents - paid;
    if (balance <= 0) continue;
    const sched = ctx.db.select().from(tables.paymentSchedule).where(eq(tables.paymentSchedule.orderId, o.id)).orderBy(tables.paymentSchedule.position).all();
    let left = paid;
    let dueOn: string | null = null;
    for (const s of sched) {
      const covered = Math.min(left, s.amountCents);
      left -= covered;
      if (covered < s.amountCents && s.dueDate) {
        dueOn = s.dueDate;
        break;
      }
    }
    const issuedOn = ymdIn((o.acceptedAt ?? o.sentAt ?? o.createdAt).getTime(), tz);
    const basis = dueOn ?? issuedOn;
    const daysOverdue = basis < today ? Math.round((Date.parse(today) - Date.parse(basis)) / 86_400_000) : 0;
    rows.push({ id: o.id, label: `Invoice ${o.invoiceNumber}`, title: o.title, contactId: o.contactId, totalCents: o.totalCents, paidCents: paid, balanceCents: balance, issuedOn, dueOn, daysOverdue });
  }
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balanceCents - a.balanceCents);
  const overdue = rows.filter((r) => r.dueOn !== null && r.daysOverdue > 0).reduce((n, r) => n + r.balanceCents, 0);

  const currency = ctx.settings.get("money.currency") || "USD";
  return {
    range,
    currency,
    totals: {
      invoicedCents: invoiced,
      taxInvoicedCents: tax,
      collectedCents: collected,
      refundedCents: refunded,
      netCollectedCents: collected - refunded,
      invoiceCount,
      paymentCount,
      averageInvoiceCents: invoiceCount ? Math.round(invoiced / invoiceCount) : 0,
    },
    outstanding: { totalCents: rows.reduce((n, r) => n + r.balanceCents, 0), overdueCents: overdue, count: rows.length, rows: rows.slice(0, 100) },
    byMonth: [...months.values()],
    byMethod: [...methods.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.cents - a.cents),
    byShootType: [...typeRows.values()].filter((t) => t.invoicedCents !== 0 || t.collectedCents !== 0).sort((a, b) => b.collectedCents - a.collectedCents || b.invoicedCents - a.invoicedCents),
  };
}

/** Comma-separated text a spreadsheet opens. Every cell is quoted, and a leading = + - @ is defused. */
export function toCsv(rows: Array<Array<string | number>>): string {
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}


/** Every payment and refund in the range, one row each, for an accountant or a spreadsheet. */
export function paymentsCsv(ctx: ServiceContext, range: ReportRange): string {
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const startMs = startOfDay(range.from, tz);
  const endMs = startOfDay(addDays(range.to, 1), tz);
  const rows: Array<Array<string | number>> = [["Date", "Invoice", "Client", "Method", "Amount", "Note"]];
  const joined = ctx.db
    .select({ p: payment, o: order, c: tables.contact })
    .from(payment)
    .innerJoin(order, eq(order.id, payment.orderId))
    .innerJoin(tables.contact, eq(tables.contact.id, order.contactId))
    .all()
    .filter((r) => r.p.paidAt.getTime() >= startMs && r.p.paidAt.getTime() < endMs)
    .sort((a, b) => a.p.paidAt.getTime() - b.p.paidAt.getTime());
  for (const { p, o, c } of joined) {
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || "";
    rows.push([ymdIn(p.paidAt.getTime(), tz), o.invoiceNumber ? `Invoice ${o.invoiceNumber}` : o.title, name, p.method, (p.amountCents / 100).toFixed(2), p.note ?? ""]);
  }
  return toCsv(rows);
}
