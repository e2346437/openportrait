import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { calendarEntry } from "./calendar.js";
import { contact } from "./people.js";
import { lead, shootType } from "./pipeline.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Every email the app sends or tries to send. Kept so a client's "I never got it" can be answered. */
export const emailLog = sqliteTable(
  "email_log",
  {
    id: text().primaryKey(),
    toAddress: text().notNull(),
    toName: text(),
    subject: text().notNull(),
    bodyText: text().notNull(),
    bodyHtml: text(),
    /** What it was for, such as "inquiry.thanks" or "booking.confirmed". */
    kind: text().notNull().default("other"),
    contactId: text().references(() => contact.id, { onDelete: "set null" }),
    /** Set by features that email about a shoot or gallery, so each can show what was sent. */
    shootId: text(),
    galleryId: text(),
    status: text({ enum: ["queued", "sent", "failed"] }).notNull().default("queued"),
    error: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    sentAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("email_log_created_idx").on(t.createdAt), index("email_log_contact_idx").on(t.contactId), index("email_log_gallery_idx").on(t.galleryId)],
);

/** A bookable appointment type with its own public page, such as "15-minute intro call" or "Mini session". */
export const scheduler = sqliteTable(
  "scheduler",
  {
    id: text().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    durationMinutes: integer().notNull().default(30),
    bufferBeforeMinutes: integer().notNull().default(0),
    bufferAfterMinutes: integer().notNull().default(0),
    /** How soon before a slot it stops being offered. */
    minNoticeHours: integer().notNull().default(12),
    maxDaysAhead: integer().notNull().default(60),
    /** Gap between offered start times. */
    stepMinutes: integer().notNull().default(30),
    location: text(),
    /** The shoot type an inquiry from this page is filed under. */
    shootTypeId: text().references(() => shootType.id, { onDelete: "set null" }),
    approval: text({ enum: ["manual", "auto"] }).notNull().default("manual"),
    /** What the session costs, in cents. Zero means the page is free to book. */
    priceCents: integer().notNull().default(0),
    /** The deposit asked up front. "percent" stores `depositValue` in basis points (2500 = 25%); "fixed" stores cents. */
    depositType: text({ enum: ["none", "percent", "fixed"] }).notNull().default("none"),
    depositValue: integer().notNull().default(0),
    /** A contract template the client must sign before they can pay online. Empty means no contract. */
    contractTemplateId: text(),
    /** Weekly hours: { "1": [{ "start": "09:00", "end": "17:00" }], ... } with 0 = Sunday. */
    availability: text({ mode: "json" }).$type<Record<string, Array<{ start: string; end: string }>>>().notNull(),
    active: integer({ mode: "boolean" }).notNull().default(true),
    position: integer().notNull().default(0),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("scheduler_slug_idx").on(t.slug)],
);

/** A client's request for, or confirmed booking of, a scheduler slot. The time is held on the calendar from the moment it's requested. */
export const schedulerBooking = sqliteTable(
  "scheduler_booking",
  {
    id: text().primaryKey(),
    schedulerId: text()
      .notNull()
      .references(() => scheduler.id, { onDelete: "cascade" }),
    contactId: text()
      .notNull()
      .references(() => contact.id),
    leadId: text().references(() => lead.id, { onDelete: "set null" }),
    entryId: text().references(() => calendarEntry.id, { onDelete: "set null" }),
    /** The invoice raised for a paid page, so the deposit is paid and tracked like any other invoice. */
    orderId: text(),
    startsAt: integer({ mode: "timestamp_ms" }).notNull(),
    endsAt: integer({ mode: "timestamp_ms" }).notNull(),
    status: text({ enum: ["pending", "confirmed", "declined", "cancelled"] }).notNull(),
    message: text(),
    /** Lets the client cancel from the link in their email, with nothing else to remember. */
    token: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("scheduler_booking_start_idx").on(t.startsAt), uniqueIndex("scheduler_booking_token_idx").on(t.token)],
);
