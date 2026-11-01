import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * A login a camera uses to upload. Each account is confined to its own folder inside the Incoming share,
 * so a camera can't see or touch another camera's files. Passwords are stored as Argon2 hashes.
 */
export const cameraAccount = sqliteTable("camera_account", {
  id: text().primaryKey(),
  /** What the photographer calls it, such as "Nikon Z9". */
  label: text().notNull(),
  username: text().notNull().unique(),
  passwordHash: text().notNull(),
  /** Optional SSH public key (SFTP only), in OpenSSH format, as an alternative to the password. */
  publicKey: text(),
  /** Folder name inside Incoming that this login is confined to. */
  folder: text().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  lastLoginAt: integer({ mode: "timestamp_ms" }),
  lastUploadAt: integer({ mode: "timestamp_ms" }),
  filesReceived: integer().notNull().default(0),
  bytesReceived: integer().notNull().default(0),
  disabledAt: integer({ mode: "timestamp_ms" }),
});
