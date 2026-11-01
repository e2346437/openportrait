import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Key/value studio settings. Values are JSON. Secrets are stored encrypted (see packages/db/src/secrets.ts). */
export const setting = sqliteTable("setting", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
});

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text().notNull(),
  role: text({ enum: ["owner", "staff", "assistant"] }).notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  lastLoginAt: integer({ mode: "timestamp_ms" }),
  disabledAt: integer({ mode: "timestamp_ms" }),
});

/** Staff sessions. `id` is the SHA-256 of the cookie token, so a leaked database can't be replayed. */
export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    lastSeenAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    ip: text(),
    userAgent: text(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: integer({ mode: "timestamp_ms" }).notNull().default(now),
    userId: text(),
    /** "user" for staff actions, "ai" when an AI connection acted (see connectionId). */
    actorType: text({ enum: ["user", "ai", "system"] }).notNull().default("user"),
    connectionId: text(),
    action: text().notNull(),
    detail: text({ mode: "json" }),
    ip: text(),
  },
  (t) => [index("audit_log_at_idx").on(t.at)],
);

/**
 * An AI assistant allowed to use the MCP endpoint. `tokenHash` is the SHA-256 of the access token,
 * which is shown once at creation. `level` caps which tool risk tiers the connection may call.
 */
export const aiConnection = sqliteTable(
  "ai_connection",
  {
    id: text().primaryKey(),
    label: text().notNull(),
    kind: text({ enum: ["token", "oauth"] }).notNull().default("token"),
    tokenHash: text().notNull().unique(),
    tokenHint: text().notNull(),
    level: text({ enum: ["read", "assist", "full"] }).notNull().default("read"),
    areas: text({ mode: "json" }).$type<string[]>().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    expiresAt: integer({ mode: "timestamp_ms" }),
    lastUsedAt: integer({ mode: "timestamp_ms" }),
    revokedAt: integer({ mode: "timestamp_ms" }),
  },
);
