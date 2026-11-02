import { desc, eq, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { logActivity } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { formatMoney } from "./money.js";
import { paidOf, recordPayment } from "./orders.js";

const { creditEntry, contact, order } = tables;

const money = (ctx: ServiceContext, cents: number) => formatMoney(cents, ctx.settings.get("money.currency") || "USD");

export function creditBalance(ctx: ServiceContext, contactId: string): number {
  return ctx.db.select({ n: sql<number>`coalesce(sum(${creditEntry.amountCents}), 0)` }).from(creditEntry).where(eq(creditEntry.contactId, contactId)).get()?.n ?? 0;
}

export function listCredit(ctx: ServiceContext, contactId: string) {
  if (!ctx.db.select({ id: contact.id }).from(contact).where(eq(contact.id, contactId)).get()) throw notFound("Contact");
  const entries = ctx.db.select().from(creditEntry).where(eq(creditEntry.contactId, contactId)).orderBy(desc(creditEntry.createdAt)).limit(100).all();
  return { balanceCents: creditBalance(ctx, contactId), entries };
}

function amountOf(raw: number) {
  if (!Number.isInteger(raw) || raw <= 0 || raw > 100_000_000) throw new DomainError("invalid", "Enter an amount greater than zero.");
  return raw;
}

/** Adds credit: a gift card sold, a prepayment, a goodwill gesture. */
export function grantCredit(ctx: ServiceContext, contactId: string, input: { amountCents: number; note?: string | null }) {
  if (!ctx.db.select({ id: contact.id }).from(contact).where(eq(contact.id, contactId)).get()) throw notFound("Contact");
  const cents = amountOf(input.amountCents);
  ctx.db.insert(creditEntry).values({ id: newId(), contactId, amountCents: cents, kind: "grant", note: input.note?.trim().slice(0, 300) || null, actorId: ctx.actorId }).run();
  logActivity(ctx, { contactId, kind: "credit.added", summary: `${money(ctx, cents)} credit added${input.note?.trim() ? ` (${input.note.trim().slice(0, 100)})` : ""}` });
  return listCredit(ctx, contactId);
}

/** Takes credit away, for a mistake. It can't go below zero. */
export function removeCredit(ctx: ServiceContext, contactId: string, input: { amountCents: number; note?: string | null }) {
  const cents = amountOf(input.amountCents);
  const have = creditBalance(ctx, contactId);
  if (cents > have) throw new DomainError("invalid", `This client only has ${money(ctx, have)} of credit.`);
  ctx.db.insert(creditEntry).values({ id: newId(), contactId, amountCents: -cents, kind: "removed", note: input.note?.trim().slice(0, 300) || null, actorId: ctx.actorId }).run();
  logActivity(ctx, { contactId, kind: "credit.removed", summary: `${money(ctx, cents)} credit removed` });
  return listCredit(ctx, contactId);
}

/** How much credit could go toward this invoice right now. */
export function creditAvailable(ctx: ServiceContext, orderId: string): number {
  const o = ctx.db.select().from(order).where(eq(order.id, orderId)).get();
  if (!o || o.kind !== "invoice" || o.status !== "sent") return 0;
  return Math.max(0, Math.min(creditBalance(ctx, o.contactId), o.totalCents - paidOf(ctx, o.id)));
}

/** Pays some or all of an invoice from the client's credit. Defaults to as much as possible. */
export function applyCredit(ctx: ServiceContext, orderId: string, amountCents?: number) {
  const o = ctx.db.select().from(order).where(eq(order.id, orderId)).get();
  if (!o) throw notFound("That invoice");
  if (o.kind !== "invoice" || o.status !== "sent") throw new DomainError("invalid", "Credit can be used on a sent invoice.");
  const owed = Math.max(0, o.totalCents - paidOf(ctx, orderId));
  const have = creditBalance(ctx, o.contactId);
  if (owed === 0) throw new DomainError("invalid", "This is already paid.");
  if (have <= 0) throw new DomainError("invalid", "There's no credit to use.");
  const cents = amountCents === undefined ? Math.min(have, owed) : amountOf(amountCents);
  if (cents > have) throw new DomainError("invalid", `Only ${money(ctx, have)} of credit is available.`);
  if (cents > owed) throw new DomainError("invalid", `That's more than the ${money(ctx, owed)} still owed.`);
  const entryId = newId();
  ctx.db.transaction((tx) => {
    const t = { ...ctx, db: tx as unknown as ServiceContext["db"] };
    t.db.insert(creditEntry).values({ id: entryId, contactId: o.contactId, amountCents: -cents, kind: "applied", orderId, actorId: ctx.actorId }).run();
    recordPayment(t, orderId, { amountCents: cents, method: "credit", note: "Client credit" }, { provider: "credit", providerRef: entryId });
  });
  return { appliedCents: cents, remainingCreditCents: creditBalance(ctx, o.contactId) };
}

