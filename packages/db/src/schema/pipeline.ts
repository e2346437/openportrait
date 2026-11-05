import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { contact } from "./people.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/** The columns of the lead board. `kind` says what reaching the stage means, so stages can be renamed freely. */
export const leadStage = sqliteTable("lead_stage", {
  id: text().primaryKey(),
  name: text().notNull(),
  position: integer().notNull(),
  kind: text({ enum: ["open", "won", "lost"] }).notNull(),
});

/** Headshot, Wedding, Lifestyle, ... Drives folder names, and later default questionnaires, contracts and auto-publish. */
export const shootType = sqliteTable("shoot_type", {
  id: text().primaryKey(),
  name: text().notNull(),
  /** The word used for `{type}` in folder names. Defaults to the name. */
  folderLabel: text().notNull(),
  /** Sends a gallery live as soon as an export finishes. Off by default. */
  autoPublish: integer({ mode: "boolean" }).notNull().default(false),
  position: integer().notNull(),
  archivedAt: integer({ mode: "timestamp_ms" }),
});

export const lead = sqliteTable(
  "lead",
  {
    id: text().primaryKey(),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text()
      .notNull()
      .references(() => leadStage.id),
    shootTypeId: text().references(() => shootType.id, { onDelete: "set null" }),
    /** Where this inquiry came from (contact form, booking page, referral, ...). */
    source: text(),
    /** What the client wrote. Always treat as untrusted text. */
    message: text(),
    /** The date they have in mind, if any, as YYYY-MM-DD. */
    eventDate: text(),
    lostReason: text(),
    convertedShootId: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    closedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("lead_stage_idx").on(t.stageId, t.createdAt), index("lead_contact_idx").on(t.contactId)],
);

export const shoot = sqliteTable(
  "shoot",
  {
    id: text().primaryKey(),
    /** The people being photographed ("Jane Smith", "Emma & Liam"). Defaults to the client's name. Used in folder names. */
    subject: text().notNull(),
    shootTypeId: text()
      .notNull()
      .references(() => shootType.id),
    status: text({ enum: ["booked", "shot", "editing", "delivered", "complete", "cancelled"] })
      .notNull()
      .default("booked"),
    primaryContactId: text()
      .notNull()
      .references(() => contact.id),
    leadId: text(),
    /** Folder under the galleries share, relative to it. Stored once and never silently changed. */
    folderPath: text(),
    /** A group day (headshot block, mini-session day) is a parent; each person or family on it is a child pointing here. */
    parentId: text(),
    kind: text({ enum: ["single", "group_day"] }).notNull().default("single"),
    /** `parent`: the parent's invoice covers this child (corporate block). `self`: the child is billed on their own. */
    billTo: text({ enum: ["self", "parent"] }).notNull().default("self"),
    /** False keeps a child off the parent's master page. */
    showOnMaster: integer({ mode: "boolean" }).notNull().default(true),
    notes: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("shoot_parent_idx").on(t.parentId), index("shoot_status_idx").on(t.status), index("shoot_contact_idx").on(t.primaryContactId), index("shoot_folder_idx").on(t.folderPath)],
);

/** A dated, located part of a shoot (the ceremony, the portraits, a second location). The calendar reads these. */
export const shootEvent = sqliteTable(
  "shoot_event",
  {
    id: text().primaryKey(),
    shootId: text()
      .notNull()
      .references(() => shoot.id, { onDelete: "cascade" }),
    title: text().notNull().default(""),
    startsAt: integer({ mode: "timestamp_ms" }).notNull(),
    endsAt: integer({ mode: "timestamp_ms" }).notNull(),
    allDay: integer({ mode: "boolean" }).notNull().default(false),
    location: text(),
  },
  (t) => [index("shoot_event_start_idx").on(t.startsAt), index("shoot_event_shoot_idx").on(t.shootId)],
);

/** Everyone connected to a shoot. The primary contact is on `shoot`; others (partner, planner, parent) go here. */
export const shootContact = sqliteTable(
  "shoot_contact",
  {
    shootId: text()
      .notNull()
      .references(() => shoot.id, { onDelete: "cascade" }),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    role: text().notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.shootId, t.contactId] })],
);

/** A to-do on a shoot ("Edit the gallery", "Send the questionnaire reminder"). Due dates are plain calendar days in the studio's time zone. */
export const shootTask = sqliteTable(
  "shoot_task",
  {
    id: text().primaryKey(),
    shootId: text()
      .notNull()
      .references(() => shoot.id, { onDelete: "cascade" }),
    title: text().notNull(),
    dueDate: text(),
    doneAt: integer({ mode: "timestamp_ms" }),
    position: integer().notNull().default(0),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("shoot_task_shoot_idx").on(t.shootId), index("shoot_task_due_idx").on(t.doneAt, t.dueDate)],
);

/**
 * One line of a shoot's day-of run sheet ("3:30 Golden-hour portraits at the pier").
 * `startMinutes` is the wall-clock time as minutes after midnight, in the studio's time zone.
 */
export const shootRunItem = sqliteTable(
  "shoot_run_item",
  {
    id: text().primaryKey(),
    shootId: text()
      .notNull()
      .references(() => shoot.id, { onDelete: "cascade" }),
    startMinutes: integer().notNull(),
    durationMinutes: integer(),
    title: text().notNull(),
    location: text(),
    notes: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("shoot_run_item_shoot_idx").on(t.shootId, t.startMinutes)],
);

/** A checklist every new shoot of a type starts with. `dueDays` counts from the shoot's first date (negative is before). */
export const shootTypeTask = sqliteTable(
  "shoot_type_task",
  {
    id: text().primaryKey(),
    shootTypeId: text()
      .notNull()
      .references(() => shootType.id, { onDelete: "cascade" }),
    title: text().notNull(),
    dueDays: integer(),
    position: integer().notNull().default(0),
  },
  (t) => [index("shoot_type_task_type_idx").on(t.shootTypeId)],
);
