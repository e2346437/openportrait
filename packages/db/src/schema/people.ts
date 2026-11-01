import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./system.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/** An optional grouping (a family or a company) so several contacts can share an address and history. */
export const household = sqliteTable("household", {
  id: text().primaryKey(),
  name: text().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
});

export const contact = sqliteTable(
  "contact",
  {
    id: text().primaryKey(),
    householdId: text().references(() => household.id, { onDelete: "set null" }),
    firstName: text().notNull().default(""),
    lastName: text().notNull().default(""),
    /** Lower-cased. Not unique: partners and parents often share one address. */
    email: text(),
    phone: text(),
    company: text(),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    region: text(),
    postalCode: text(),
    country: text(),
    /** Where they first heard of the studio (referral, Instagram, ...). Free text, suggested from past values. */
    source: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    /** Archived contacts are hidden from lists and search but their history is kept. */
    archivedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("contact_email_idx").on(t.email), index("contact_name_idx").on(t.lastName, t.firstName), index("contact_household_idx").on(t.householdId)],
);

export const tag = sqliteTable("tag", {
  id: text().primaryKey(),
  /** Stored as typed; unique ignoring case (enforced by the service). */
  name: text().notNull().unique(),
});

export const contactTag = sqliteTable(
  "contact_tag",
  {
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    tagId: text()
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] }), index("contact_tag_tag_idx").on(t.tagId)],
);

/** A note written by staff. Attached to a contact, and optionally to one of that contact's leads or shoots. */
export const note = sqliteTable(
  "note",
  {
    id: text().primaryKey(),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    leadId: text(),
    shootId: text(),
    body: text().notNull(),
    authorId: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("note_contact_idx").on(t.contactId, t.createdAt)],
);

/**
 * The contact's timeline: things that happened (lead created, stage changed, shoot booked, ...).
 * Later modules add their own kinds (email sent, payment received, gallery viewed).
 */
export const activity = sqliteTable(
  "activity",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    leadId: text(),
    shootId: text(),
    kind: text().notNull(),
    summary: text().notNull(),
    detail: text({ mode: "json" }),
    /** A staff user id, or null when the system did it. */
    actorId: text(),
    at: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("activity_contact_idx").on(t.contactId, t.at)],
);
