import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { contact } from "./people.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Reusable contract wording. Merge fields like {{client.name}} are filled in when a contract is made from it. */
export const contractTemplate = sqliteTable("contract_template", {
  id: text().primaryKey(),
  name: text().notNull(),
  body: text().notNull(),
  archivedAt: integer({ mode: "timestamp_ms" }),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
});

/**
 * One contract for one client. `body` is the wording after merge fields were filled in: a snapshot, so editing a
 * template never changes a contract already sent. Once signed it is locked, and `bodyHash` proves it didn't change.
 */
export const contract = sqliteTable(
  "contract",
  {
    id: text().primaryKey(),
    templateId: text(),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "restrict" }),
    shootId: text(),
    orderId: text(),
    title: text().notNull(),
    body: text().notNull(),
    bodyHash: text().notNull(),
    status: text({ enum: ["draft", "sent", "signed", "void"] }).notNull().default("draft"),
    /** The private link the client uses. Long and random. */
    token: text().notNull(),
    sentAt: integer({ mode: "timestamp_ms" }),
    viewedAt: integer({ mode: "timestamp_ms" }),
    signedAt: integer({ mode: "timestamp_ms" }),
    signerName: text(),
    signerEmail: text(),
    signMethod: text({ enum: ["typed", "drawn"] }),
    /** For a drawn signature: a small PNG data URL. */
    signatureImage: text(),
    signerIp: text(),
    signerUserAgent: text(),
    consentText: text(),
    countersignedAt: integer({ mode: "timestamp_ms" }),
    countersignedBy: text(),
    voidedAt: integer({ mode: "timestamp_ms" }),
    pdfPath: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("contract_token_idx").on(t.token), index("contract_contact_idx").on(t.contactId), index("contract_shoot_idx").on(t.shootId), index("contract_status_idx").on(t.status, t.createdAt)],
);
