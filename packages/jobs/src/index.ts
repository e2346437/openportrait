import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";

/**
 * A small persistent job queue on top of SQLite.
 *
 *   const thumbs = defineJob("gallery.thumbnails", async ({ photoId }: { photoId: string }, ctx) => { ... });
 *   enqueue(db, thumbs, { photoId }, { dedupeKey: `thumbs:${photoId}` });
 *   new JobRunner(db, { logger }).start();
 *
 * Jobs run in this process. Failed jobs retry with exponential backoff up to maxAttempts.
 */

export interface JobContext {
  db: Db;
  attempt: number;
  logger: Logger;
  signal: AbortSignal;
}

export type JobHandler<P> = (payload: P, ctx: JobContext) => Promise<void>;

export interface JobDefinition<P> {
  name: string;
  handler: JobHandler<P>;
  maxAttempts: number;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const registry = new Map<string, JobDefinition<unknown>>();

export function defineJob<P>(name: string, handler: JobHandler<P>, opts: { maxAttempts?: number } = {}): JobDefinition<P> {
  // Redefining replaces the handler (the app can be built more than once in one process, e.g. in tests).
  const def: JobDefinition<P> = { name, handler, maxAttempts: opts.maxAttempts ?? 5 };
  registry.set(name, def as JobDefinition<unknown>);
  return def;
}

/** For tests only. */
export function clearJobRegistry(): void {
  registry.clear();
}

export interface EnqueueOptions {
  runAt?: Date;
  /** If a queued or running job already has this key, nothing new is queued. */
  dedupeKey?: string;
}

export function enqueue<P>(db: Db, job: JobDefinition<P> | string, payload: P, opts: EnqueueOptions = {}): number | null {
  const name = typeof job === "string" ? job : job.name;
  const def = registry.get(name);
  return db.transaction((tx) => {
    if (opts.dedupeKey) {
      const existing = tx
        .select({ id: tables.job.id })
        .from(tables.job)
        .where(and(eq(tables.job.dedupeKey, opts.dedupeKey), inArray(tables.job.state, ["queued", "running"])))
        .get();
      if (existing) return null;
    }
    const row = tx
      .insert(tables.job)
      .values({
        name,
        payload: payload as unknown,
        runAt: opts.runAt ?? new Date(),
        dedupeKey: opts.dedupeKey ?? null,
        maxAttempts: def?.maxAttempts ?? 5,
      })
      .returning({ id: tables.job.id })
      .get();
    return row.id;
  });
}

export interface RunnerOptions {
  logger: Logger;
  pollMs?: number;
  concurrency?: number;
  /** A job still "running" after this long (e.g. the container was killed) is retried. */
  staleAfterMs?: number;
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopped = true;
  private readonly abort = new AbortController();
  private readonly pollMs: number;
  private readonly concurrency: number;
  private readonly staleAfterMs: number;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly db: Db,
    private readonly opts: RunnerOptions,
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.concurrency = opts.concurrency ?? 2;
    this.staleAfterMs = opts.staleAfterMs ?? 15 * 60_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.requeueStale();
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    await this.idle();
  }

  /** Resolves when no job is running. */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Runs every due job once, then resolves. Handy in tests. */
  async drain(): Promise<void> {
    for (;;) {
      const claimed = this.claim();
      if (!claimed) break;
      await this.run(claimed);
    }
  }

  private requeueStale(): void {
    const cutoff = new Date(Date.now() - this.staleAfterMs);
    this.db
      .update(tables.job)
      .set({ state: "queued", lockedAt: null })
      .where(and(eq(tables.job.state, "running"), lte(tables.job.lockedAt, cutoff)))
      .run();
  }

  private tick = (): void => {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      const claimed = this.claim();
      if (!claimed) break;
      void this.run(claimed);
    }
    this.timer = setTimeout(this.tick, this.pollMs);
  };

  private claim() {
    const due = sql`(SELECT id FROM job WHERE state = 'queued' AND run_at <= ${Date.now()} ORDER BY run_at, id LIMIT 1)`;
    return this.db
      .update(tables.job)
      .set({ state: "running", lockedAt: new Date(), attempts: sql`${tables.job.attempts} + 1` })
      .where(eq(tables.job.id, due))
      .returning()
      .get();
  }

  private async run(row: typeof tables.job.$inferSelect): Promise<void> {
    this.active++;
    const { logger } = this.opts;
    try {
      const def = registry.get(row.name);
      if (!def) throw new Error(`No handler is defined for job "${row.name}"`);
      await def.handler(row.payload, { db: this.db, attempt: row.attempts, logger, signal: this.abort.signal });
      this.db
        .update(tables.job)
        .set({ state: "done", finishedAt: new Date(), lockedAt: null, lastError: null })
        .where(eq(tables.job.id, row.id))
        .run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const giveUp = row.attempts >= row.maxAttempts;
      // 10s, 40s, 2.5min, 10min, ... capped at 1 hour
      const delay = Math.min(10_000 * 4 ** (row.attempts - 1), 3_600_000);
      this.db
        .update(tables.job)
        .set(
          giveUp
            ? { state: "failed", finishedAt: new Date(), lockedAt: null, lastError: message }
            : { state: "queued", runAt: new Date(Date.now() + delay), lockedAt: null, lastError: message },
        )
        .where(eq(tables.job.id, row.id))
        .run();
      (giveUp ? logger.error : logger.warn).call(logger, { job: row.name, id: row.id, attempt: row.attempts, err: message }, giveUp ? "job failed" : "job will retry");
    } finally {
      this.active--;
      if (this.active === 0) this.idleResolvers.splice(0).forEach((r) => r());
    }
  }
}
