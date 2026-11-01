import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema/index.js";

export * as schema from "./schema/index.js";
export { schema as tables };
export { DEFAULT_DESIGN, type GalleryDesign } from "./schema/galleries.js";
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const here = path.dirname(fileURLToPath(import.meta.url));
/** Migrations ship next to the package (packages/db/migrations), both in dev and in the image. */
export const migrationsDir = path.resolve(here, "../migrations");

export interface OpenOptions {
  /** Path to the SQLite file, or ":memory:". */
  file: string;
  migrate?: boolean;
}

export function openDatabase({ file, migrate: runMigrations = true }: OpenOptions): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const client = new Database(file);
  client.pragma("journal_mode = WAL");
  client.pragma("synchronous = NORMAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  const db = drizzle({ client, schema, casing: "snake_case" }) as Db;
  if (runMigrations) migrate(db, { migrationsFolder: migrationsDir });
  return db;
}

/** Consistent online snapshot via SQLite's backup API (safe while the app is running). */
export async function backupDatabase(db: Db, destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await db.$client.backup(destination);
}
