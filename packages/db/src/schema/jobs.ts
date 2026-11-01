import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Background jobs, persisted so they survive restarts. Used by @openportrait/jobs. */
export const job = sqliteTable(
  "job",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    payload: text({ mode: "json" }).notNull(),
    state: text({ enum: ["queued", "running", "done", "failed"] }).notNull().default("queued"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    runAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    lockedAt: integer({ mode: "timestamp_ms" }),
    lastError: text(),
    /** Optional key that prevents duplicate queued jobs (e.g. "thumbs:photo:123"). */
    dedupeKey: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    finishedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("job_ready_idx").on(t.state, t.runAt), index("job_dedupe_idx").on(t.dedupeKey, t.state)],
);
