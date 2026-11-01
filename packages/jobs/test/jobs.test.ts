import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, tables } from "@openportrait/db";
import { clearJobRegistry, defineJob, enqueue, JobRunner } from "../src/index.js";

const logger = { info() {}, warn() {}, error() {} };

describe("jobs", () => {
  beforeEach(() => clearJobRegistry());

  it("runs a queued job once", async () => {
    const db = openDatabase({ file: ":memory:" });
    const seen: number[] = [];
    const job = defineJob("test.add", async (p: { n: number }) => {
      seen.push(p.n);
    });
    enqueue(db, job, { n: 7 });
    await new JobRunner(db, { logger }).drain();
    expect(seen).toEqual([7]);
    expect(db.select().from(tables.job).get()?.state).toBe("done");
  });

  it("dedupes by key while a job is queued", () => {
    const db = openDatabase({ file: ":memory:" });
    const job = defineJob("test.noop", async () => {});
    expect(enqueue(db, job, {}, { dedupeKey: "a" })).toBeTypeOf("number");
    expect(enqueue(db, job, {}, { dedupeKey: "a" })).toBeNull();
  });

  it("retries with backoff, then fails after maxAttempts", async () => {
    const db = openDatabase({ file: ":memory:" });
    const job = defineJob("test.boom", async () => {
      throw new Error("nope");
    }, { maxAttempts: 2 });
    const id = enqueue(db, job, {})!;
    const runner = new JobRunner(db, { logger });
    await runner.drain();
    let row = db.select().from(tables.job).where(eq(tables.job.id, id)).get()!;
    expect(row.state).toBe("queued");
    expect(row.lastError).toBe("nope");
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
    db.update(tables.job).set({ runAt: new Date(0) }).where(eq(tables.job.id, id)).run();
    await runner.drain();
    row = db.select().from(tables.job).where(eq(tables.job.id, id)).get()!;
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(2);
  });
});
