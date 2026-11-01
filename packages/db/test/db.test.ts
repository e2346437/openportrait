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
