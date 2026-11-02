import { eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import type { ServiceContext } from "./context.js";
import { toCsv } from "./reports.js";
import { ymdIn } from "./time.js";

const { contact, contactTag, tag, shoot, shootType, shootEvent, order, payment } = tables;

export type ExportKind = "contacts" | "shoots" | "invoices";
export const EXPORT_KINDS: ExportKind[] = ["contacts", "shoots", "invoices"];

/** Column names match what Import data recognises, so an export can be brought back in unchanged. */
const tz = (ctx: ServiceContext) => ctx.settings.get("studio.timezone") ?? "UTC";
const money = (cents: number) => (cents / 100).toFixed(2);

function contactsCsv(ctx: ServiceContext): string {
  const tags = new Map<string, string[]>();
  for (const r of ctx.db.select({ id: contactTag.contactId, name: tag.name }).from(contactTag).innerJoin(tag, eq(tag.id, contactTag.tagId)).all()) {
    tags.set(r.id, [...(tags.get(r.id) ?? []), r.name]);
  }
  const rows: Array<Array<string | number>> = [["ID", "First Name", "Last Name", "Company", "Email", "Phone", "Street Address", "Street Address 2", "City", "State/Prov", "Zip/Postal Code", "Country", "Referral Source", "Tags", "Archived"]];
  for (const c of ctx.db.select().from(contact).all().sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName))) {
    rows.push([c.id, c.firstName, c.lastName, c.company ?? "", c.email ?? "", c.phone ?? "", c.addressLine1 ?? "", c.addressLine2 ?? "", c.city ?? "", c.region ?? "", c.postalCode ?? "", c.country ?? "", c.source ?? "", [...(tags.get(c.id) ?? [])].sort((a, b) => a.localeCompare(b)).join("; "), c.archivedAt ? "yes" : ""]);
  }
  return toCsv(rows);
}

function shootsCsv(ctx: ServiceContext): string {
  const zone = tz(ctx);
  const firstEvent = new Map<string, number>();
  for (const e of ctx.db.select().from(shootEvent).all()) {
    const t = e.startsAt.getTime();
    if (t < (firstEvent.get(e.shootId) ?? Infinity)) firstEvent.set(e.shootId, t);
  }
  const header = ["ID", "Shoot Name", "Shoot Date", "Shoot Type", "Status", "First Name", "Last Name", "Email", "Notes"];
  const rows: Array<Array<string | number>> = [];
  const joined = ctx.db
    .select({ s: shoot, t: shootType, c: contact })
    .from(shoot)
    .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
    .innerJoin(contact, eq(contact.id, shoot.primaryContactId))
    .all();
  for (const { s, t, c } of joined) {
    const at = firstEvent.get(s.id);
    rows.push([s.id, s.subject, at === undefined ? "" : ymdIn(at, zone), t.name, s.status, c.firstName, c.lastName, c.email ?? "", s.notes ?? ""]);
  }
  rows.sort((a, b) => String(a[2]).localeCompare(String(b[2])));
  return toCsv([header, ...rows]);
}

/** One row per payment. An invoice with no payments yet is one row with the payment columns blank. */
function invoicesCsv(ctx: ServiceContext): string {
  const zone = tz(ctx);
  const shoots = new Map(ctx.db.select({ id: shoot.id, subject: shoot.subject }).from(shoot).all().map((s) => [s.id, s.subject]));
  const pays = new Map<string, Array<typeof payment.$inferSelect>>();
  for (const p of ctx.db.select().from(payment).all().sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())) pays.set(p.orderId, [...(pays.get(p.orderId) ?? []), p]);
  const rows: Array<Array<string | number>> = [["ID", "Order Number", "Title", "First Name", "Last Name", "Company", "Email", "Shoot", "Total", "Created", "Paid On", "Amount", "Payment Method", "Status"]];
  const joined = ctx.db.select({ o: order, c: contact }).from(order).innerJoin(contact, eq(contact.id, order.contactId)).where(eq(order.kind, "invoice")).all();
  joined.sort((a, b) => (a.o.invoiceNumber ?? 0) - (b.o.invoiceNumber ?? 0));
  for (const { o, c } of joined) {
    const base = [o.id, o.invoiceNumber ?? "", o.title, c.firstName, c.lastName, c.company ?? "", c.email ?? "", (o.shootId && shoots.get(o.shootId)) || "", money(o.totalCents), ymdIn(o.createdAt.getTime(), zone)];
    const list = pays.get(o.id) ?? [];
    if (!list.length) rows.push([...base, "", "", "", o.status]);
    for (const p of list) rows.push([...base, ymdIn(p.paidAt.getTime(), zone), money(p.amountCents), p.method, o.status]);
  }
  return toCsv(rows);
}

export function exportCsv(ctx: ServiceContext, kind: ExportKind): string {
  return kind === "contacts" ? contactsCsv(ctx) : kind === "shoots" ? shootsCsv(ctx) : invoicesCsv(ctx);
}
