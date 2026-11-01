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
    status: text({ enum: ["queued", "sent", "failed"] }).notNull().default("queued"),
    error: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    sentAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("email_log_created_idx").on(t.createdAt), index("email_log_contact_idx").on(t.contactId)],
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
