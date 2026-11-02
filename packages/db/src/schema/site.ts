import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * The studio's website draft (docs/website.md). One row, id "main". `config` holds the whole site definition
 * (template, colors, fonts, pages, picked photos); the server validates it on every save, so the column is opaque here.
 */
export const site = sqliteTable("site", {
  id: text().primaryKey(),
  config: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  lastExportedAt: integer({ mode: "timestamp_ms" }),
});
