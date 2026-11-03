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
export type { QuestionField } from "./schema/questionnaires.js";
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
  if (runMigrations) {
    if (file !== ":memory:") snapshotBeforeMigrating(client, file);
    migrate(db, { migrationsFolder: migrationsDir });
  }
  return db;
}

const KEEP_SNAPSHOTS = 3;

/**
 * Updating the app can change the database in a way older versions can't read. When there are migrations to apply to a
 * database that already has data, keep a consistent copy first (`pre-migrate/` beside the database) so a bad update
 * can be undone. Never blocks startup: if the copy can't be made, the update still goes ahead.
 */
function snapshotBeforeMigrating(client: Database.Database, file: string): void {
  try {
    const applied = client.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get()
      ? ((client.prepare("select max(created_at) as latest from __drizzle_migrations").get() as { latest: number | null }).latest ?? null)
      : null;
    if (applied === null || applied >= appLatestMigration()) return; // a new database, or already up to date
    const dir = path.join(path.dirname(file), "pre-migrate");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    client.prepare("vacuum into ?").run(path.join(dir, `${path.basename(file)}.${stamp}`));
    const old = fs.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(file)}.`)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - KEEP_SNAPSHOTS))) fs.rmSync(path.join(dir, n), { force: true });
  } catch (err) {
    console.warn(`Couldn't save a copy of the database before updating it: ${err instanceof Error ? err.message : err}`);
  }
}

/** Consistent online snapshot via SQLite's backup API (safe while the app is running). */
export async function backupDatabase(db: Db, destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await db.$client.backup(destination);
}

export interface DatabaseInspection {
  /** True when this is a SQLite file that passed SQLite's own integrity check. */
  ok: boolean;
  /** Plain-language reason when `ok` is false. */
  problem?: string;
  /** The newest migration the file has applied (its timestamp), or null when none. */
  latestMigration: number | null;
  /** The newest migration this version of the app knows. */
  appLatestMigration: number;
  counts: { contacts: number; shoots: number; orders: number };
}

function appLatestMigration(): number {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8")) as { entries: Array<{ when: number }> };
  return Math.max(0, ...journal.entries.map((e) => e.when));
}

/**
 * Looks inside a database file without changing it: opens it read-only, runs SQLite's integrity check, and reports
 * how far its schema has got so a file from a newer version can be refused. Never runs migrations.
 */
export function inspectDatabase(file: string): DatabaseInspection {
  const base = { latestMigration: null, appLatestMigration: appLatestMigration(), counts: { contacts: 0, shoots: 0, orders: 0 } };
  let client: Database.Database | null = null;
  try {
    client = new Database(file, { readonly: true, fileMustExist: true });
    const check = client.pragma("integrity_check", { simple: true });
    if (check !== "ok") return { ...base, ok: false, problem: "The database inside this backup is damaged." };
    const tables = new Set((client.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
    if (!tables.has("__drizzle_migrations") || !tables.has("setting") || !tables.has("user")) return { ...base, ok: false, problem: "This file isn't an OpenPortrait database." };
    const latest = (client.prepare("select max(created_at) as m from __drizzle_migrations").get() as { m: number | null }).m;
    const count = (t: string) => (tables.has(t) ? (client!.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n : 0);
    return { ...base, ok: true, latestMigration: latest, counts: { contacts: count("contact"), shoots: count("shoot"), orders: count('"order"') } };
  } catch {
    return { ...base, ok: false, problem: "This file isn't a readable OpenPortrait database." };
  } finally {
    client?.close();
  }
}
