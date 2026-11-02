import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { contact } from "./people.js";
import { shoot, shootType } from "./pipeline.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/** One question on a form. Stored as JSON on the template, and copied onto each sent questionnaire. */
export interface QuestionField {
  id: string;
  type: "heading" | "text" | "textarea" | "number" | "date" | "yesno" | "select" | "multiselect";
  label: string;
  help?: string;
  required?: boolean;
  /** For select and multiselect. */
  options?: string[];
}

/** A reusable form: "Wedding details", "Headshot preferences". */
export const questionnaireTemplate = sqliteTable("questionnaire_template", {
  id: text().primaryKey(),
  name: text().notNull(),
  /** Shown to the client above the questions. */
  intro: text(),
  fields: text({ mode: "json" }).$type<QuestionField[]>().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  archivedAt: integer({ mode: "timestamp_ms" }),
});

/** Which form a shoot type uses, and whether it goes out by itself when a shoot of that type is booked. */
export const shootTypeQuestionnaire = sqliteTable("shoot_type_questionnaire", {
  shootTypeId: text()
    .primaryKey()
    .references(() => shootType.id, { onDelete: "cascade" }),
  templateId: text()
    .notNull()
    .references(() => questionnaireTemplate.id, { onDelete: "cascade" }),
  sendMode: text({ enum: ["manual", "on_booking"] }).notNull().default("manual"),
});

/** A form sent (or ready to send) for one shoot. The questions are a snapshot, so editing the template never changes a sent form. */
export const questionnaire = sqliteTable(
  "questionnaire",
  {
    id: text().primaryKey(),
    shootId: text()
      .notNull()
      .references(() => shoot.id, { onDelete: "cascade" }),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    templateId: text(),
    title: text().notNull(),
    intro: text(),
    fields: text({ mode: "json" }).$type<QuestionField[]>().notNull(),
    /** draft: made but not sent. sent: the client has the link. submitted: answers are in. */
    status: text({ enum: ["draft", "sent", "submitted"] }).notNull().default("draft"),
    /** The private link the client uses. Long and random. */
    token: text().notNull(),
    /** Field id to the client's answer: a string, a list of strings, or a yes/no boolean. */
    answers: text({ mode: "json" }).$type<Record<string, string | string[] | boolean>>(),
    sentAt: integer({ mode: "timestamp_ms" }),
    viewedAt: integer({ mode: "timestamp_ms" }),
    submittedAt: integer({ mode: "timestamp_ms" }),
    /** How the questionnaire got sent: by hand, or by a shoot type's automatic rule. */
    origin: text({ enum: ["manual", "auto"] }).notNull().default("manual"),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("questionnaire_token_idx").on(t.token), index("questionnaire_shoot_idx").on(t.shootId, t.createdAt)],
);
