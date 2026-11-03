import crypto from "node:crypto";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { displayName, logActivity } from "./contacts.js";
import { DomainError, linkTo, newId, notFound, type ServiceContext } from "./context.js";
import { evaluate as evaluateCoupon } from "./coupons.js";
import { composeEmail, queueEmail } from "./email.js";
import { formatMoney, totalsFor } from "./money.js";
import { cleanRich, safeRich } from "./richtext.js";
import { resolveRate, type TaxPick } from "./tax.js";
import { addDays, isYmd, ymdIn } from "./time.js";

const { order, orderLine, paymentSchedule, payment, counter, contact, creditEntry } = tables;

export type OrderRow = typeof order.$inferSelect;

export const METHODS = ["cash", "check", "card", "venmo", "zelle", "paypal", "bank", "credit", "other"] as const;
export type Method = (typeof METHODS)[number];

export interface OrderLineInput {
  itemId?: string | null;
  description: string;
  detail?: string | null;
  quantity?: number;
  unitCents: number;
  taxable?: boolean;
}
export interface ScheduleInput {
  label: string;
  amountCents: number;
  dueDate?: string | null;
}
export interface OrderInput {
  contactId: string;
  shootId?: string | null;
  leadId?: string | null;
  title: string;
  intro?: string | null;
  terms?: string | null;
  discountCents?: number;
  /** A coupon code to apply. Empty or omitted means none. */
  couponCode?: string | null;
  /** The booking page this document comes from. Lets a coupon limited to that page apply. */
  schedulerId?: string | null;
  validUntil?: string | null;
  /** One of the studio's tax rates. Omit for the default. */
  taxRateId?: string | null;
  lines: OrderLineInput[];
  /** Omit for one payment of the whole amount, due on acceptance. */
  schedule?: ScheduleInput[];
}

const currency = (ctx: ServiceContext) => ctx.settings.get("money.currency") || "USD";
const money = (ctx: ServiceContext, cents: number) => formatMoney(cents, currency(ctx));
const tzOf = (ctx: ServiceContext) => ctx.settings.get("studio.timezone") ?? "UTC";
const today = (ctx: ServiceContext) => ymdIn(Date.now(), tzOf(ctx));

export function nextNumber(tx: Pick<ServiceContext["db"], "select" | "insert" | "update">, name: "quote" | "invoice"): number {
  const row = tx.select().from(counter).where(eq(counter.name, name)).get();
  if (!row) {
    tx.insert(counter).values({ name, value: 1001 }).run();
    return 1001;
  }
  tx.update(counter).set({ value: row.value + 1 }).where(eq(counter.name, name)).run();
  return row.value + 1;
}

const label = (o: { kind: string; quoteNumber: number | null; invoiceNumber: number | null }) => (o.kind === "invoice" ? `Invoice ${o.invoiceNumber}` : `Quote ${o.quoteNumber}`);

// ---- reading ----


export function paidOf(ctx: ServiceContext, orderId: string): number {
  return ctx.db.select({ n: sql<number>`coalesce(sum(${payment.amountCents}), 0)` }).from(payment).where(eq(payment.orderId, orderId)).get()?.n ?? 0;
}

/** Lays payments over the schedule in order, so each installment shows how much of it is covered. */
function installments(rows: Array<typeof paymentSchedule.$inferSelect>, paid: number, todayYmd: string) {
  let left = Math.max(0, paid);
  return rows.map((r) => {
    const covered = Math.min(left, r.amountCents);
    left -= covered;
    const done = covered >= r.amountCents;
    return { id: r.id, label: r.label, amountCents: r.amountCents, dueDate: r.dueDate || null, paidCents: covered, status: done ? ("paid" as const) : r.dueDate && r.dueDate < todayYmd ? ("overdue" as const) : ("due" as const) };
  });
}

export type OrderState = "draft" | "sent" | "expired" | "declined" | "void" | "unpaid" | "partial" | "paid";

function stateOf(ctx: ServiceContext, o: OrderRow, paid: number): OrderState {
  if (o.status === "void") return "void";
  if (o.status === "draft") return "draft";
  if (o.kind === "quote") {
    if (o.status === "declined") return "declined";
    return o.validUntil && o.validUntil < today(ctx) ? "expired" : "sent";
  }
  if (paid >= o.totalCents && o.totalCents > 0) return "paid";
  return paid > 0 ? "partial" : "unpaid";
}

function summarize(ctx: ServiceContext, o: OrderRow) {
  const paid = paidOf(ctx, o.id);
  return {
    id: o.id,
    kind: o.kind,
    number: o.kind === "invoice" ? o.invoiceNumber : o.quoteNumber,
    label: label(o),
    title: o.title,
    contactId: o.contactId,
    shootId: o.shootId,
    state: stateOf(ctx, o, paid),
    totalCents: o.totalCents,
    paidCents: paid,
    balanceCents: o.kind === "invoice" ? Math.max(0, o.totalCents - paid) : o.totalCents,
    validUntil: o.validUntil,
    sentAt: o.sentAt,
    acceptedAt: o.acceptedAt,
    createdAt: o.createdAt,
  };
}

export function listOrders(ctx: ServiceContext, f: { kind?: "quote" | "invoice"; contactId?: string; shootId?: string; q?: string; limit?: number } = {}) {
  const conds = [];
  if (f.kind) conds.push(eq(order.kind, f.kind));
  if (f.contactId) conds.push(eq(order.contactId, f.contactId));
  if (f.shootId) conds.push(eq(order.shootId, f.shootId));
  if (f.q?.trim()) {
    const q = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    conds.push(or(like(order.title, q), like(contact.firstName, q), like(contact.lastName, q), like(contact.company, q))!);
  }
  const rows = ctx.db
    .select({ o: order, c: contact })
    .from(order)
    .innerJoin(contact, eq(contact.id, order.contactId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(order.createdAt))
    .limit(Math.min(f.limit ?? 200, 500))
    .all();
  return rows.map(({ o, c }) => ({ ...summarize(ctx, o), contactName: displayName(c) }));
}

function rowOf(ctx: ServiceContext, id: string): OrderRow {
  const o = ctx.db.select().from(order).where(eq(order.id, id)).get();
  if (!o) throw notFound("That quote or invoice");
  return o;
}

function detail(ctx: ServiceContext, o: OrderRow) {
  const lines = ctx.db.select().from(orderLine).where(eq(orderLine.orderId, o.id)).orderBy(asc(orderLine.position)).all();
  const sched = ctx.db.select().from(paymentSchedule).where(eq(paymentSchedule.orderId, o.id)).orderBy(asc(paymentSchedule.position)).all();
  const payments = ctx.db.select().from(payment).where(eq(payment.orderId, o.id)).orderBy(asc(payment.paidAt)).all();
  const paid = payments.reduce((n, p) => n + p.amountCents, 0);
  const c = ctx.db.select().from(contact).where(eq(contact.id, o.contactId)).get();
  return {
    ...summarize(ctx, o),
    intro: safeRich(o.intro) || null,
    terms: o.terms === null ? null : safeRich(o.terms),
    subtotalCents: o.subtotalCents,
    /** The hand-typed discount. The coupon's share is `couponCents`; the two add up to what was taken off. */
    discountCents: o.discountCents - o.couponCents,
    couponCode: o.couponCode,
    couponCents: o.couponCents,
    taxCents: o.taxCents,
    taxBps: o.taxBps,
    taxRateId: o.taxRateId,
    taxLabel: o.taxLabel,
    token: o.token,
    contactName: c ? displayName(c) : "",
    contactEmail: c?.email ?? null,
    lines: lines.map((l) => ({ id: l.id, itemId: l.itemId, description: l.description, detail: l.detail, quantity: l.quantity, unitCents: l.unitCents, taxable: l.taxable })),
    schedule: installments(sched, paid, today(ctx)),
    payments: payments.map((p) => ({ id: p.id, amountCents: p.amountCents, method: p.method, provider: p.provider, note: p.note, paidAt: p.paidAt })),
    acceptedName: o.acceptedName,
    viewedAt: o.viewedAt,
    declinedAt: o.declinedAt,
    link: linkTo(ctx, `/o/${o.token}`),
  };
}

export const getOrder = (ctx: ServiceContext, id: string) => detail(ctx, rowOf(ctx, id));

// ---- writing ----

function clean(ctx: ServiceContext, input: OrderInput, taxBps: number, existing?: OrderRow) {
  const title = input.title.trim();
  if (!title) throw new DomainError("invalid", "Give it a title, such as “Wedding collection”.");
  if (input.lines.length === 0) throw new DomainError("invalid", "Add at least one line.");
  if (input.lines.length > 100) throw new DomainError("invalid", "That's too many lines.");
  const lines = input.lines.map((l, i) => {
    const description = l.description.trim();
    const quantity = l.quantity ?? 1;
    if (!description) throw new DomainError("invalid", `Line ${i + 1} needs a description.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new DomainError("invalid", `Line ${i + 1}: quantity must be a whole number from 1 to 9999.`);
    if (!Number.isInteger(l.unitCents) || Math.abs(l.unitCents) > 100_000_000) throw new DomainError("invalid", `Line ${i + 1}: enter a valid price.`);
    return { itemId: l.itemId ?? null, description: description.slice(0, 300), detail: l.detail?.trim().slice(0, 1000) || null, quantity, unitCents: l.unitCents, taxable: l.taxable ?? true };
  });
  const discount = input.discountCents ?? 0;
  if (!Number.isInteger(discount) || discount < 0) throw new DomainError("invalid", "The discount must be zero or more.");
  const code = input.couponCode?.trim();
  const coupon = code ? evaluateCoupon(ctx, code, lines, { orderId: existing?.id, keepCouponId: existing?.couponId, manualDiscountCents: discount, schedulerId: input.schedulerId }) : null;
  const totals = totalsFor(lines, discount + (coupon?.cents ?? 0), taxBps);
  if (totals.totalCents < 0) throw new DomainError("invalid", "The total can't be below zero.");
  if (input.validUntil && !isYmd(input.validUntil)) throw new DomainError("invalid", "Enter the “valid until” date as year-month-day.");
  const schedule = (input.schedule?.length ? input.schedule : [{ label: "Payment in full", amountCents: totals.totalCents, dueDate: null }]).map((s) => {
    if (!s.label.trim()) throw new DomainError("invalid", "Name each payment, such as “Deposit”.");
    if (!Number.isInteger(s.amountCents) || s.amountCents < 0) throw new DomainError("invalid", "Payment amounts must be zero or more.");
    if (s.dueDate && !isYmd(s.dueDate)) throw new DomainError("invalid", "Enter due dates as year-month-day.");
    return { label: s.label.trim().slice(0, 100), amountCents: s.amountCents, dueDate: s.dueDate || null };
  });
  const sum = schedule.reduce((n, s) => n + s.amountCents, 0);
  if (sum !== totals.totalCents) throw new DomainError("invalid", `The payments add up to ${money(ctx, sum)}, but the total is ${money(ctx, totals.totalCents)}.`);
  return { title, lines, totals, schedule, coupon, validUntil: input.validUntil || null };
}

function ensureContact(ctx: ServiceContext, id: string) {
  const c = ctx.db.select({ id: contact.id }).from(contact).where(eq(contact.id, id)).get();
  if (!c) throw notFound("Contact");
}

function write(ctx: ServiceContext, id: string, input: OrderInput, rate: TaxPick, existing?: OrderRow) {
  const taxBps = rate.bps;
  const v = clean(ctx, input, taxBps, existing);
  ctx.db
    .update(order)
    .set({ title: v.title, intro: cleanRich(input.intro) || null, terms: input.terms === undefined || input.terms === null ? null : cleanRich(input.terms), discountCents: v.totals.discountCents, couponId: v.coupon?.couponId ?? null, couponCode: v.coupon?.code ?? null, couponCents: v.coupon?.cents ?? 0, subtotalCents: v.totals.subtotalCents, taxCents: v.totals.taxCents, totalCents: v.totals.totalCents, taxBps, taxRateId: rate.id, taxLabel: rate.label, validUntil: v.validUntil, shootId: input.shootId ?? null, leadId: input.leadId ?? null, updatedAt: new Date() })
    .where(eq(order.id, id))
    .run();
  ctx.db.delete(orderLine).where(eq(orderLine.orderId, id)).run();
  ctx.db.delete(paymentSchedule).where(eq(paymentSchedule.orderId, id)).run();
  v.lines.forEach((l, i) => ctx.db.insert(orderLine).values({ id: newId(), orderId: id, position: i, ...l }).run());
  v.schedule.forEach((s, i) => ctx.db.insert(paymentSchedule).values({ id: newId(), orderId: id, position: i, ...s }).run());
}

export function createOrder(ctx: ServiceContext, kind: "quote" | "invoice", input: OrderInput) {
  ensureContact(ctx, input.contactId);
  const rate = resolveRate(ctx, input.taxRateId);
  const id = newId();
  ctx.db.transaction((tx) => {
    const t = { ...ctx, db: tx as unknown as ServiceContext["db"] };
    t.db
      .insert(order)
      .values({
        id,
        kind,
        title: input.title.trim() || "Untitled",
        contactId: input.contactId,
        token: crypto.randomBytes(24).toString("base64url"),
        quoteNumber: kind === "quote" ? nextNumber(tx as never, "quote") : null,
        invoiceNumber: kind === "invoice" ? nextNumber(tx as never, "invoice") : null,
        terms: ctx.settings.get("money.terms") || null,
      })
      .run();
    write(t, id, { ...input, terms: input.terms ?? ctx.settings.get("money.terms") ?? null }, rate);
  });
  const o = rowOf(ctx, id);
  logActivity(ctx, { contactId: o.contactId, kind: `${kind}.created`, summary: `${label(o)} drafted: ${o.title}`, shootId: o.shootId, leadId: o.leadId });
  return detail(ctx, o);
}

export function updateOrder(ctx: ServiceContext, id: string, input: OrderInput) {
  const o = rowOf(ctx, id);
  if (o.status !== "draft") throw new DomainError("locked", "Only a draft can be edited. Reopen it as a draft first, or void it and start a new one.");
  ensureContact(ctx, input.contactId);
  ctx.db.transaction((tx) => {
    const t = { ...ctx, db: tx as unknown as ServiceContext["db"] };
    t.db.update(order).set({ contactId: input.contactId }).where(eq(order.id, id)).run();
    write(t, id, input, resolveRate(ctx, input.taxRateId ?? o.taxRateId), o);
  });
  return getOrder(ctx, id);
}

export function deleteDraft(ctx: ServiceContext, id: string) {
  const o = rowOf(ctx, id);
  if (o.status !== "draft") throw new DomainError("locked", "Only a draft can be deleted. Void anything that has been sent.");
  ctx.db.delete(order).where(eq(order.id, id)).run();
  return { ok: true };
}

/** Takes a sent quote nobody has accepted back to a draft, so it can be corrected and sent again. */
export function reopenDraft(ctx: ServiceContext, id: string) {
  const o = rowOf(ctx, id);
  if (o.kind !== "quote" || o.status === "draft") throw new DomainError("invalid", "Only a sent quote can be taken back to a draft.");
  ctx.db.update(order).set({ status: "draft", sentAt: null, declinedAt: null, updatedAt: new Date() }).where(eq(order.id, id)).run();
  return getOrder(ctx, id);
}

function notifyClient(ctx: ServiceContext, o: OrderRow, subject: string, paragraphs: string[], action: { label: string; url: string } | undefined, kind: string) {
  const c = ctx.db.select().from(contact).where(eq(contact.id, o.contactId)).get();
  if (!c?.email) return false;
  const studio = ctx.settings.get("studio.name") || "the studio";
  const mail = composeEmail(studio, [`Hi ${c.firstName || "there"},`, ...paragraphs], action);
  return !!queueEmail(ctx, { to: c.email, toName: displayName(c), subject, text: mail.text, html: mail.html, kind, contactId: c.id, shootId: o.shootId });
}

function notifyStudio(ctx: ServiceContext, subject: string, text: string) {
  const owner = ctx.settings.get("studio.email");
  if (!owner) return;
  const studio = ctx.settings.get("studio.name") || "OpenPortrait";
  const mail = composeEmail(studio, [text]);
  queueEmail(ctx, { to: owner, subject, text: mail.text, html: mail.html, kind: "order.notice" });
}

/** Makes a draft visible to the client and emails them the link. Returns whether an email was queued. */
export function sendOrder(ctx: ServiceContext, id: string) {
  const o = rowOf(ctx, id);
  if (o.status !== "draft") throw new DomainError("invalid", "This has already been sent.");
  const c = ctx.db.select().from(contact).where(eq(contact.id, o.contactId)).get();
  if (!c?.email) throw new DomainError("no_email", "Add an email address to this contact before sending.");
  if (o.totalCents <= 0) throw new DomainError("invalid", "The total is zero. Add a priced line before sending.");
  const validUntil = o.kind === "quote" ? (o.validUntil ?? addDays(today(ctx), ctx.settings.get("money.quoteValidDays") ?? 30)) : o.validUntil;
  ctx.db.update(order).set({ status: "sent", sentAt: new Date(), validUntil, updatedAt: new Date() }).where(eq(order.id, id)).run();
  const sent = rowOf(ctx, id);
  const url = linkTo(ctx, `/o/${sent.token}`);
  const emailed =
    o.kind === "quote"
      ? notifyClient(ctx, sent, `${sent.title}: your quote`, [`Here is your quote for ${sent.title}, ${money(ctx, sent.totalCents)}.`, validUntil ? `It's good until ${validUntil}.` : ""].filter(Boolean), { label: "View your quote", url }, "quote.sent")
      : notifyClient(ctx, sent, `Invoice ${sent.invoiceNumber}: ${sent.title}`, [`Here is your invoice for ${sent.title}, ${money(ctx, sent.totalCents)}.`], { label: "View your invoice", url }, "invoice.sent");
  logActivity(ctx, { contactId: sent.contactId, kind: `${sent.kind}.sent`, summary: `${label(sent)} sent: ${sent.title} (${money(ctx, sent.totalCents)})`, shootId: sent.shootId, leadId: sent.leadId });
  return { ...getOrder(ctx, id), emailed };
}

export function voidOrder(ctx: ServiceContext, id: string) {
  const o = rowOf(ctx, id);
  if (o.status === "void") return getOrder(ctx, id);
  if (paidOf(ctx, id) !== 0) throw new DomainError("invalid", "Payments have been recorded. Refund them first, then void.");
  ctx.db.update(order).set({ status: "void", updatedAt: new Date() }).where(eq(order.id, id)).run();
  logActivity(ctx, { contactId: o.contactId, kind: `${o.kind}.void`, summary: `${label(o)} voided`, shootId: o.shootId });
  return getOrder(ctx, id);
}

// ---- payments ----

export interface PaymentInput {
  amountCents: number;
  method: Method;
  note?: string | null;
  paidAt?: number;
}

/** Records money received outside the app (cash, check, Venmo) or confirmed by a processor. */
export function recordPayment(ctx: ServiceContext, id: string, input: PaymentInput, source: { provider?: string; providerRef?: string } = {}) {
  const o = rowOf(ctx, id);
  if (o.kind !== "invoice" || o.status !== "sent") throw new DomainError("invalid", "Payments can be recorded on a sent invoice.");
  if (!METHODS.includes(input.method)) throw new DomainError("invalid", "Choose how it was paid.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("invalid", "Enter the amount received.");
  if (input.method === "credit" && source.provider !== "credit") throw new DomainError("invalid", "Use “Apply credit” to pay from a client's credit.");
  if (source.provider && source.providerRef) {
    // A processor can tell us about the same payment twice (the client returning and a webhook). Record it once.
    const seen = ctx.db.select({ id: payment.id }).from(payment).where(and(eq(payment.provider, source.provider), eq(payment.providerRef, source.providerRef))).get();
    if (seen) return getOrder(ctx, id);
  }
  const paid = paidOf(ctx, id);
  const balance = o.totalCents - paid;
  // Money a processor already took is recorded even if the balance changed meanwhile; only hand-typed amounts are limited.
  if (!source.provider && input.amountCents > balance) throw new DomainError("invalid", `That's more than the ${money(ctx, balance)} still owed.`);
  const paymentId = newId();
  ctx.db
    .insert(payment)
    .values({ id: paymentId, orderId: id, amountCents: input.amountCents, method: input.method, provider: source.provider ?? "manual", providerRef: source.providerRef ?? null, note: input.note?.trim().slice(0, 500) || null, paidAt: new Date(input.paidAt ?? Date.now()), recordedBy: ctx.actorId })
    .run();
  logActivity(ctx, { contactId: o.contactId, kind: "payment.received", summary: `${money(ctx, input.amountCents)} received for ${label(o)} (${input.method})`, shootId: o.shootId });
  const left = Math.max(0, balance - input.amountCents);
  notifyClient(ctx, o, `Receipt: ${money(ctx, input.amountCents)} for ${o.title}`, [`Thank you. I received ${money(ctx, input.amountCents)} for ${label(o)}.`, left > 0 ? `The balance is ${money(ctx, left)}.` : "It's paid in full."], { label: "View your invoice", url: linkTo(ctx, `/o/${o.token}`) }, "payment.receipt");
  return getOrder(ctx, id);
}

export function refundPayment(ctx: ServiceContext, id: string, input: { amountCents: number; method: Method; note?: string | null }) {
  const o = rowOf(ctx, id);
  if (o.kind !== "invoice") throw new DomainError("invalid", "Only an invoice has payments.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("invalid", "Enter the amount refunded.");
  const paid = paidOf(ctx, id);
  if (input.amountCents > paid) throw new DomainError("invalid", `Only ${money(ctx, paid)} has been paid.`);
  ctx.db.insert(payment).values({ id: newId(), orderId: id, amountCents: -input.amountCents, method: input.method, provider: "manual", note: input.note?.trim().slice(0, 500) || "Refund", paidAt: new Date(), recordedBy: ctx.actorId }).run();
  if (input.method === "credit") {
    // Refunding to credit keeps the money with the studio as a balance the client can spend later.
    ctx.db.insert(creditEntry).values({ id: newId(), contactId: o.contactId, amountCents: input.amountCents, kind: "refund", note: `Refund from ${label(o)}`, orderId: id, actorId: ctx.actorId }).run();
  }
  logActivity(ctx, { contactId: o.contactId, kind: "payment.refunded", summary: `${money(ctx, input.amountCents)} refunded on ${label(o)}${input.method === "credit" ? " as client credit" : ""}`, shootId: o.shootId });
  return getOrder(ctx, id);
}

/** A refund the processor reports (made from PayPal's own screens). Recorded once per refund id. */
export function recordProcessorRefund(ctx: ServiceContext, orderId: string, input: { amountCents: number; method: Method; provider: string; providerRef: string }) {
  const o = rowOf(ctx, orderId);
  const seen = ctx.db.select({ id: payment.id }).from(payment).where(and(eq(payment.provider, input.provider), eq(payment.providerRef, input.providerRef))).get();
  if (seen) return;
  ctx.db.insert(payment).values({ id: newId(), orderId, amountCents: -input.amountCents, method: input.method, provider: input.provider, providerRef: input.providerRef, note: "Refunded by the payment processor", paidAt: new Date() }).run();
  logActivity(ctx, { contactId: o.contactId, kind: "payment.refunded", summary: `${money(ctx, input.amountCents)} refunded on ${label(o)} (${input.method})`, shootId: o.shootId });
}

/** What the next payment on the schedule still needs, capped at the balance. Zero when nothing is owed. */
export function nextDueCents(ctx: ServiceContext, o: OrderRow): number {
  const paid = paidOf(ctx, o.id);
  const balance = Math.max(0, o.totalCents - paid);
  if (balance === 0) return 0;
  const sched = ctx.db.select().from(paymentSchedule).where(eq(paymentSchedule.orderId, o.id)).orderBy(asc(paymentSchedule.position)).all();
  const next = installments(sched, paid, today(ctx)).find((s) => s.status !== "paid");
  return next ? Math.min(balance, next.amountCents - next.paidCents) : balance;
}

// ---- what the client sees ----

export function byToken(ctx: ServiceContext, token: string): OrderRow {
  const o = ctx.db.select().from(order).where(eq(order.token, token)).get();
  if (!o || o.status === "draft") throw notFound("This page");
  return o;
}

export function publicView(ctx: ServiceContext, token: string) {
  const o = byToken(ctx, token);
  if (!o.viewedAt) {
    ctx.db.update(order).set({ viewedAt: new Date() }).where(eq(order.id, o.id)).run();
    notifyStudio(ctx, `${label(o)} was opened`, `${displayName(ctx.db.select().from(contact).where(eq(contact.id, o.contactId)).get()!)} opened ${label(o)}: ${o.title}.`);
  }
  const d = detail(ctx, o);
  return {
    studioName: ctx.settings.get("studio.name") ?? "",
    currency: currency(ctx),
    kind: d.kind,
    label: d.label,
    title: d.title,
    state: d.state,
    intro: d.intro,
    terms: d.terms,
    lines: d.lines.map((l) => ({ description: l.description, detail: l.detail, quantity: l.quantity, unitCents: l.unitCents })),
    subtotalCents: d.subtotalCents,
    discountCents: d.discountCents,
    couponCode: d.couponCode,
    couponCents: d.couponCents,
    taxCents: d.taxCents,
    taxLabel: d.taxLabel,
    totalCents: d.totalCents,
    paidCents: d.paidCents,
    balanceCents: d.balanceCents,
    validUntil: d.validUntil,
    acceptedAt: d.acceptedAt,
    acceptedName: d.acceptedName,
    schedule: d.schedule,
    payments: d.payments.map((p) => ({ amountCents: p.amountCents, method: p.method, paidAt: p.paidAt })),
    paymentInstructions: ctx.settings.get("money.paymentInstructions") ?? "",
    contactName: d.contactName,
  };
}

/** The client accepts a quote by typing their name. It becomes an invoice in place, keeping the same link. */
export function acceptQuote(ctx: ServiceContext, token: string, input: { name: string; ip?: string }) {
  const o = byToken(ctx, token);
  const name = input.name.trim();
  if (o.kind !== "quote") throw new DomainError("invalid", "This has already been accepted.");
  if (o.status === "void") throw new DomainError("invalid", "This quote is no longer available.");
  if (o.status === "declined") throw new DomainError("invalid", "This quote was declined.");
  if (o.validUntil && o.validUntil < today(ctx)) throw new DomainError("expired", "This quote has expired. Please ask for a new one.");
  if (name.length < 2) throw new DomainError("invalid", "Type your full name to accept.");
  const number = ctx.db.transaction((tx) => nextNumber(tx as never, "invoice"));
  ctx.db.update(order).set({ kind: "invoice", invoiceNumber: number, acceptedAt: new Date(), acceptedName: name.slice(0, 120), acceptedIp: input.ip?.slice(0, 64) ?? null, updatedAt: new Date() }).where(eq(order.id, o.id)).run();
  const a = rowOf(ctx, o.id);
  logActivity(ctx, { contactId: a.contactId, kind: "quote.accepted", summary: `${name} accepted Quote ${a.quoteNumber}; it is now Invoice ${a.invoiceNumber} (${money(ctx, a.totalCents)})`, shootId: a.shootId, leadId: a.leadId });
  notifyStudio(ctx, `Quote ${a.quoteNumber} accepted`, `${name} accepted ${a.title} for ${money(ctx, a.totalCents)}. It is now Invoice ${a.invoiceNumber}.`);
  notifyClient(ctx, a, `Thank you: ${a.title}`, [`Thank you for accepting ${a.title}. Your invoice is ${label(a)}, ${money(ctx, a.totalCents)}.`], { label: "View your invoice", url: linkTo(ctx, `/o/${a.token}`) }, "quote.accepted");
  return publicView(ctx, token);
}

/**
 * Shifts a payment schedule to a new total. Fixed amounts the client already agreed to stay as they are for as long
 * as possible: a smaller total comes off the last payment first (the balance), a larger one lands on the last payment.
 * Payments that shrink to nothing are dropped, and there is always at least one.
 */
export function rebalance(rows: Array<{ label: string; amountCents: number; dueDate: string | null }>, totalCents: number) {
  const out = rows.map((r) => ({ ...r }));
  let diff = totalCents - out.reduce((n, r) => n + r.amountCents, 0);
  if (diff > 0) out[out.length - 1]!.amountCents += diff;
  for (let i = out.length - 1; i >= 0 && diff < 0; i--) {
    const take = Math.min(out[i]!.amountCents, -diff);
    out[i]!.amountCents -= take;
    diff += take;
  }
  const kept = out.filter((r) => r.amountCents > 0);
  return kept.length ? kept : [{ ...out[out.length - 1]!, amountCents: totalCents }];
}

/**
 * The client types a coupon code on a quote they haven't accepted yet. The discount and total are recalculated and the
 * payment schedule follows: the deposit stays the same and the balance absorbs the change. A code that would give less
 * than the discount the quote already has is refused, so entering a code can only help the client.
 */
export function applyQuoteCoupon(ctx: ServiceContext, token: string, rawCode: string) {
  const o = byToken(ctx, token);
  if (o.kind !== "quote" || o.status !== "sent") throw new DomainError("invalid", "A coupon can only be added to a quote that is waiting for your answer.");
  if (o.validUntil && o.validUntil < today(ctx)) throw new DomainError("expired", "This quote has expired. Please ask for a new one.");
  if (!rawCode.trim()) throw new DomainError("invalid", "Type your coupon code.");
  const lines = ctx.db.select().from(orderLine).where(eq(orderLine.orderId, o.id)).orderBy(asc(orderLine.position)).all();
  const manual = o.discountCents - o.couponCents;
  const applied = evaluateCoupon(ctx, rawCode, lines, { orderId: o.id, keepCouponId: o.couponId, manualDiscountCents: manual });
  if (o.couponId === applied.couponId) throw new DomainError("invalid", `${applied.code} is already on this quote.`);
  if (o.couponId && applied.cents <= o.couponCents) throw new DomainError("invalid", `This quote already has ${o.couponCode}, which takes off ${money(ctx, o.couponCents)}. ${applied.code} wouldn't save you more.`);
  const totals = totalsFor(lines, manual + applied.cents, o.taxBps);
  const rows = ctx.db.select().from(paymentSchedule).where(eq(paymentSchedule.orderId, o.id)).orderBy(asc(paymentSchedule.position)).all();
  const schedule = rebalance(rows, totals.totalCents);
  ctx.db.transaction((tx) => {
    tx.update(order).set({ couponId: applied.couponId, couponCode: applied.code, couponCents: applied.cents, discountCents: totals.discountCents, taxCents: totals.taxCents, totalCents: totals.totalCents, updatedAt: new Date() }).where(eq(order.id, o.id)).run();
    tx.delete(paymentSchedule).where(eq(paymentSchedule.orderId, o.id)).run();
    schedule.forEach((r, i) => tx.insert(paymentSchedule).values({ id: newId(), orderId: o.id, position: i, label: r.label, amountCents: r.amountCents, dueDate: r.dueDate }).run());
  });
  logActivity(ctx, { contactId: o.contactId, kind: "quote.coupon", summary: `Client applied coupon ${applied.code} to Quote ${o.quoteNumber}: ${money(ctx, applied.cents)} off`, shootId: o.shootId, leadId: o.leadId });
  notifyStudio(ctx, `Coupon ${applied.code} used on Quote ${o.quoteNumber}`, `The client added coupon ${applied.code} to ${o.title}. It takes off ${money(ctx, applied.cents)}; the new total is ${money(ctx, totals.totalCents)}.`);
  return publicView(ctx, token);
}

export function declineQuote(ctx: ServiceContext, token: string, reason?: string) {
  const o = byToken(ctx, token);
  if (o.kind !== "quote" || o.status !== "sent") throw new DomainError("invalid", "This quote can't be declined.");
  ctx.db.update(order).set({ status: "declined", declinedAt: new Date(), updatedAt: new Date() }).where(eq(order.id, o.id)).run();
  logActivity(ctx, { contactId: o.contactId, kind: "quote.declined", summary: `Quote ${o.quoteNumber} declined`, shootId: o.shootId, leadId: o.leadId });
  notifyStudio(ctx, `Quote ${o.quoteNumber} declined`, `${o.title} was declined.${reason?.trim() ? ` They wrote: ${reason.trim().slice(0, 500)}` : ""}`);
  return publicView(ctx, token);
}

