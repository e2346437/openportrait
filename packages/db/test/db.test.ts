import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { backupDatabase, inspectDatabase, migrationsDir, openDatabase, tables } from "../src/index.js";

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

  it("adds the payment attempt reconciliation columns on a fresh database and on an upgrade, keeping existing attempts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-db-"));

    // Fresh install: the columns exist and are empty by default.
    const fresh = openDatabase({ file: path.join(dir, "fresh.db") });
    const cols = (fresh.$client.prepare("pragma table_info(payment_attempt)").all() as { name: string; notnull: number }[]).filter((c) =>
      ["currency", "review_note"].includes(c.name),
    );
    expect(cols.map((c) => c.name).sort()).toEqual(["currency", "review_note"]);
    expect(cols.every((c) => c.notnull === 0)).toBe(true);
    fresh.$client.close();

    // Upgrade: a database migrated only up to the migration before 0032, holding a real-looking attempt.
    const older = path.join(dir, "older-migrations");
    fs.cpSync(migrationsDir, older, { recursive: true });
    const journalFile = path.join(older, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
    const idx = journal.entries.findIndex((e) => e.tag.startsWith("0032_"));
    expect(idx).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, idx);
    fs.writeFileSync(journalFile, JSON.stringify(journal));

    const file = path.join(dir, "upgrade", "openportrait.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const seed = new Database(file);
    migrate(drizzle({ client: seed, schema: tables, casing: "snake_case" }), { migrationsFolder: older });
    expect((seed.pragma("table_info(payment_attempt)") as { name: string }[]).some((c) => c.name === "currency")).toBe(false);
    seed.pragma("foreign_keys = OFF"); // seed one attempt without building a whole order graph
    seed
      .prepare("insert into payment_attempt (id, order_id, provider, provider_order_id, amount_cents, status, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run("att-old", "order-old", "paypal", "PP-OLD-1", 12345, "started", 1700000000000);
    seed.close();

    openDatabase({ file }).$client.close(); // applies 0032 (and keeps a pre-migrate copy)
    expect(fs.readdirSync(path.join(path.dirname(file), "pre-migrate"))).toHaveLength(1);
    const after = openDatabase({ file, migrate: false });
    const row = after.select().from(tables.paymentAttempt).where(eq(tables.paymentAttempt.id, "att-old")).get();
    expect(row).toMatchObject({ provider: "paypal", providerOrderId: "PP-OLD-1", amountCents: 12345, status: "started", currency: null, reviewNote: null });
    // The new status is accepted by the existing table.
    after.update(tables.paymentAttempt).set({ status: "review", reviewNote: "x" }).where(eq(tables.paymentAttempt.id, "att-old")).run();
    expect(after.select().from(tables.paymentAttempt).get()?.status).toBe("review");
  });

  it("keeps invoices, PayPal attempts, payments and pending approvals intact through upgrade to 0032, backup, restore and a second upgrade", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-db-"));
    // Synthetic studio data only. Build a database as the previous release left it (migrations before 0032).
    const older = path.join(dir, "older-migrations");
    fs.cpSync(migrationsDir, older, { recursive: true });
    const journalFile = path.join(older, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag.startsWith("0032_")));
    fs.writeFileSync(journalFile, JSON.stringify(journal));

    const live = path.join(dir, "live", "openportrait.db");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    const seed = new Database(live);
    seed.pragma("journal_mode = WAL");
    seed.pragma("foreign_keys = ON"); // keep relationships real: no shortcuts
    migrate(drizzle({ client: seed, schema: tables, casing: "snake_case" }), { migrationsFolder: older });
    const t0 = 1700000000000;
    seed.prepare("insert into contact (id, first_name, last_name, email) values ('c1', 'Test', 'Client', 'client@example.test')").run();
    seed
      .prepare("insert into \"order\" (id, kind, status, invoice_number, contact_id, title, subtotal_cents, total_cents, token) values ('o1', 'invoice', 'sent', 1001, 'c1', 'Synthetic session', 30000, 30000, 'tok-o1')")
      .run();
    seed.prepare("insert into payment (id, order_id, amount_cents, method, provider, provider_ref, paid_at) values ('p-manual', 'o1', 5000, 'cash', 'manual', null, ?)").run(t0);
    seed.prepare("insert into payment (id, order_id, amount_cents, method, provider, provider_ref, paid_at) values ('p-pp', 'o1', 10000, 'paypal', 'paypal', 'CAPTURE-1', ?)").run(t0 + 1);
    seed
      .prepare("insert into payment_attempt (id, order_id, provider, provider_order_id, amount_cents, status, created_at) values ('att-paid', 'o1', 'paypal', 'PP-ORDER-1', 10000, 'paid', ?)")
      .run(t0);
    seed
      .prepare("insert into payment_attempt (id, order_id, provider, provider_order_id, amount_cents, status, created_at) values ('att-open', 'o1', 'paypal', 'PP-ORDER-2', 15000, 'started', ?)")
      .run(t0 + 2);
    seed.prepare("insert into ai_connection (id, label, kind, token_hash, token_hint, level, areas) values ('conn1', 'Synthetic assistant', 'token', 'hash-1', '...abcd', 'full', '[\"orders\"]')").run();
    seed
      .prepare("insert into ai_approval (id, connection_id, tool, tier, summary, args, binding, status, created_at, expires_at) values ('appr1', 'conn1', 'orders_apply_credit', 'money', 'Pay 50.00 of invoice 1001', '{\"amountCents\":5000}', 'bind-1', 'pending', ?, ?)")
      .run(t0, t0 + 86400000);
    seed.close();

    // Backup of the old-version database (what a restore of last week's backup would bring back).
    const oldDb = openDatabase({ file: live, migrate: false });
    const backupOld = path.join(dir, "backups", "old.db");
    await backupDatabase(oldDb, backupOld);
    oldDb.$client.close();
    // A restore accepts an older database: intact, and behind the app's newest migration.
    const inspected = inspectDatabase(backupOld);
    expect(inspected.ok).toBe(true);
    expect(inspected.latestMigration!).toBeLessThan(inspected.appLatestMigration!);
    expect(inspected.counts.orders).toBe(1);

    const graph = (db: ReturnType<typeof openDatabase>) => ({
      payments: db.select().from(tables.payment).all().map((p) => [p.id, p.orderId, p.amountCents, p.providerRef]).sort(),
      attempts: db.select().from(tables.paymentAttempt).all().map((a) => [a.id, a.orderId, a.status, a.amountCents, a.providerOrderId]).sort(),
      approvals: db.select().from(tables.aiApproval).all().map((a) => [a.id, a.connectionId, a.status, a.binding, a.args]),
      order: db.select().from(tables.order).all().map((o) => [o.id, o.status, o.invoiceNumber, o.contactId]),
      fkViolations: db.$client.pragma("foreign_key_check"),
    });

    // 1. Upgrade in place to 0032.
    const upgraded = openDatabase({ file: live });
    const before = graph(upgraded);
    expect(before.fkViolations).toEqual([]);
    expect(before.payments).toHaveLength(2);
    expect(before.attempts).toEqual([
      ["att-open", "o1", "started", 15000, "PP-ORDER-2"],
      ["att-paid", "o1", "paid", 10000, "PP-ORDER-1"],
    ]);
    expect(before.approvals).toEqual([["appr1", "conn1", "pending", "bind-1", { amountCents: 5000 }]]);
    // The new columns are empty on old attempts, which therefore can't be auto-reconciled.
    expect(upgraded.select().from(tables.paymentAttempt).all().every((a) => a.currency === null && a.reviewNote === null)).toBe(true);
    // The upgraded database takes the new status and still refuses a duplicate processor reference.
    upgraded.update(tables.paymentAttempt).set({ status: "review", currency: "USD", reviewNote: "Amount did not match" }).where(eq(tables.paymentAttempt.id, "att-open")).run();
    expect(() =>
      upgraded.insert(tables.payment).values({ id: "p-dup", orderId: "o1", amountCents: 10000, method: "paypal", provider: "paypal", providerRef: "CAPTURE-1", paidAt: new Date(t0) }).run(),
    ).toThrow(/UNIQUE/);
    const backupNew = path.join(dir, "backups", "new.db");
    await backupDatabase(upgraded, backupNew);
    const afterUpgrade = graph(upgraded);
    upgraded.$client.close();

    // 2. Restore the OLD backup over a fresh location, then upgrade it again: same data, newest schema.
    const restoredOld = path.join(dir, "restored-old", "openportrait.db");
    fs.mkdirSync(path.dirname(restoredOld), { recursive: true });
    fs.copyFileSync(backupOld, restoredOld);
    const reopenedOld = openDatabase({ file: restoredOld });
    expect(graph(reopenedOld)).toEqual(before);
    expect(reopenedOld.select().from(tables.paymentAttempt).where(eq(tables.paymentAttempt.id, "att-open")).get()).toMatchObject({ status: "started", currency: null, reviewNote: null });
    expect(fs.readdirSync(path.join(path.dirname(restoredOld), "pre-migrate"))).toHaveLength(1); // the upgrade kept its own safety copy
    reopenedOld.$client.close();

    // 3. Restore the NEW backup: nothing to migrate, and the review state, note and currency survived the backup.
    const restoredNew = path.join(dir, "restored-new", "openportrait.db");
    fs.mkdirSync(path.dirname(restoredNew), { recursive: true });
    fs.copyFileSync(backupNew, restoredNew);
    const reopenedNew = openDatabase({ file: restoredNew });
    expect(graph(reopenedNew)).toEqual(afterUpgrade);
    expect(reopenedNew.select().from(tables.paymentAttempt).where(eq(tables.paymentAttempt.id, "att-open")).get()).toMatchObject({ status: "review", currency: "USD", reviewNote: "Amount did not match" });
    expect(fs.existsSync(path.join(path.dirname(restoredNew), "pre-migrate"))).toBe(false);
    // Relationships still behave: removing the invoice's attempts with it cascades, payments still restrict.
    expect(() => reopenedNew.delete(tables.order).where(eq(tables.order.id, "o1")).run()).toThrow(/FOREIGN KEY/);
    reopenedNew.$client.close();
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
