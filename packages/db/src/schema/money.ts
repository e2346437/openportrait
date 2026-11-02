import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { contact } from "./people.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * Everything the studio sells: packages ("Wedding, 8 hours"), sessions, prints, add-ons.
 * Prices are whole cents. Quote lines copy the name and price, so changing the catalog never rewrites a sent quote.
 */
export const catalogItem = sqliteTable(
  "catalog_item",
  {
    id: text().primaryKey(),
    kind: text({ enum: ["package", "item"] }).notNull().default("item"),
    name: text().notNull(),
    description: text(),
    priceCents: integer().notNull().default(0),
    taxable: integer({ mode: "boolean" }).notNull().default(true),
    position: integer().notNull().default(0),
    archivedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("catalog_item_kind_idx").on(t.kind, t.position)],
);

/**
 * A quote becomes an invoice in place when the client accepts it, so history stays in one row.
 * `quoteNumber` is set for anything that was ever a quote, `invoiceNumber` once it is an invoice.
 */
export const order = sqliteTable(
  "order",
  {
    id: text().primaryKey(),
    kind: text({ enum: ["quote", "invoice"] }).notNull(),
    /** quote: draft, sent, declined, expired. invoice: sent (waiting for payment) or void. Payment state is worked out from payments. */
    status: text({ enum: ["draft", "sent", "declined", "void"] }).notNull().default("draft"),
    quoteNumber: integer(),
    invoiceNumber: integer(),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "restrict" }),
    shootId: text(),
    leadId: text(),
    title: text().notNull(),
    /** Shown to the client above the lines. */
    intro: text(),
    terms: text(),
    subtotalCents: integer().notNull().default(0),
    discountCents: integer().notNull().default(0),
    taxCents: integer().notNull().default(0),
    totalCents: integer().notNull().default(0),
    /** Tax rate in basis points (825 = 8.25%) fixed when the document is saved, so later rate changes don't rewrite it. */
    taxBps: integer().notNull().default(0),
    /** A quote can be accepted until this date (YYYY-MM-DD). */
    validUntil: text(),
    /** The private link clients use. Anyone with the link can view and accept, so it is long and random. */
    token: text().notNull(),
    sentAt: integer({ mode: "timestamp_ms" }),
    viewedAt: integer({ mode: "timestamp_ms" }),
    acceptedAt: integer({ mode: "timestamp_ms" }),
    /** The name the client typed to accept. */
    acceptedName: text(),
    acceptedIp: text(),
    declinedAt: integer({ mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    uniqueIndex("order_token_idx").on(t.token),
    index("order_contact_idx").on(t.contactId),
    index("order_shoot_idx").on(t.shootId),
    index("order_kind_status_idx").on(t.kind, t.status, t.createdAt),
  ],
);

export const orderLine = sqliteTable(
  "order_line",
  {
    id: text().primaryKey(),
    orderId: text()
      .notNull()
      .references(() => order.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    itemId: text(),
    description: text().notNull(),
    detail: text(),
    quantity: integer().notNull().default(1),
    unitCents: integer().notNull(),
    taxable: integer({ mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("order_line_order_idx").on(t.orderId, t.position)],
);

/** When money is due: a deposit, a balance. The amounts add up to the order total. Payments settle them in order. */
export const paymentSchedule = sqliteTable(
  "payment_schedule",
  {
    id: text().primaryKey(),
    orderId: text()
      .notNull()
      .references(() => order.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    label: text().notNull(),
    amountCents: integer().notNull(),
    /** YYYY-MM-DD, or empty for "due on acceptance". */
    dueDate: text(),
  },
  (t) => [index("payment_schedule_order_idx").on(t.orderId, t.position)],
);

/** The money ledger. Refunds are negative amounts. `provider` is "manual" or a payment processor id. */
export const payment = sqliteTable(
  "payment",
  {
    id: text().primaryKey(),
    orderId: text()
      .notNull()
      .references(() => order.id, { onDelete: "restrict" }),
    amountCents: integer().notNull(),
    method: text({ enum: ["cash", "check", "card", "venmo", "zelle", "paypal", "bank", "other"] }).notNull(),
    provider: text().notNull().default("manual"),
    /** The processor's id for this payment, so a repeated webhook can't record it twice. */
    providerRef: text(),
    note: text(),
    paidAt: integer({ mode: "timestamp_ms" }).notNull(),
    recordedBy: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("payment_order_idx").on(t.orderId, t.paidAt), uniqueIndex("payment_provider_ref_idx").on(t.provider, t.providerRef)],
);

/** Invoice and quote numbers count up from 1000 and never repeat, even when a draft is deleted. */
export const counter = sqliteTable("counter", {
  name: text().primaryKey(),
  value: integer().notNull(),
});

/**
 * A payment someone started online but that may not be finished. When the processor confirms it, a `payment` row is
 * written. Keeping the attempt lets a returning client and a webhook both complete it without recording it twice.
 */
export const paymentAttempt = sqliteTable(
  "payment_attempt",
  {
    id: text().primaryKey(),
    orderId: text()
      .notNull()
      .references(() => order.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    /** The processor's own id for the checkout (PayPal's order id). */
    providerOrderId: text().notNull(),
    amountCents: integer().notNull(),
    status: text({ enum: ["started", "paid", "failed"] }).notNull().default("started"),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("payment_attempt_provider_idx").on(t.provider, t.providerOrderId), index("payment_attempt_order_idx").on(t.orderId)],
);
