import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * Remembers which rows of an outside file became which records, so importing the same file twice
 * doesn't create everything twice. `externalKey` is the file's own id when it has one, otherwise a key built from the row.
 */
export const importRecord = sqliteTable(
  "import_record",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    kind: text().notNull(),
    externalKey: text().notNull(),
    entityId: text().notNull(),
    batchId: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("import_record_key_idx").on(t.source, t.kind, t.externalKey), index("import_record_batch_idx").on(t.batchId)],
);
