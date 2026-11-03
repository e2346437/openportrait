import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { backupDatabase, openDatabase, tables } from "../src/index.js";

describe("openDatabase", () => {
  it("runs migrations and enables WAL and foreign keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-db-"));
    const db = openDatabase({ file: path.join(dir, "openportrait.db") });
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    db.insert(tables.setting).values({ key: "studio.name", value: "Test Studio" }).run();
    const row = db.select().from(tables.setting).where(eq(tables.setting.key, "studio.name")).get();
    expect(row?.value).toBe("Test Studio");
  });

  it("keeps a copy before applying pending migrations, but not for new or current databases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-db-"));
    const file = path.join(dir, "openportrait.db");
    openDatabase({ file }).$client.close(); // brand new: nothing to protect
    expect(fs.existsSync(path.join(dir, "pre-migrate"))).toBe(false);
    openDatabase({ file }).$client.close(); // already current
    expect(fs.existsSync(path.join(dir, "pre-migrate"))).toBe(false);

    // A database from an older version: it has applied some migration, but not the newest.
    const old = path.join(dir, "old", "openportrait.db");
    const seed = openDatabase({ file: old, migrate: false });
    seed.$client.exec("create table __drizzle_migrations (id integer primary key, hash text not null, created_at numeric); insert into __drizzle_migrations (hash, created_at) values ('x', 1); create table keepme (n integer); insert into keepme values (42);");
    seed.$client.close();
    openDatabase({ file: old }).$client.close();
    const snaps = fs.readdirSync(path.join(dir, "old", "pre-migrate"));
    expect(snaps).toHaveLength(1);
    const copy = openDatabase({ file: path.join(dir, "old", "pre-migrate", snaps[0]!), migrate: false });
    expect(copy.$client.prepare("select n from keepme").get()).toEqual({ n: 42 });
  });

  it("backs up to a separate file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-db-"));
    const db = openDatabase({ file: path.join(dir, "a.db") });
    db.insert(tables.setting).values({ key: "k", value: 1 }).run();
    const dest = path.join(dir, "backups", "b.db");
    await backupDatabase(db, dest);
    const copy = openDatabase({ file: dest, migrate: false });
    expect(copy.select().from(tables.setting).all()).toHaveLength(1);
  });
});
