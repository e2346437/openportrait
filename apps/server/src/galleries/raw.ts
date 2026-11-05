import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import { isIgnoredName, isTrackableFile, resolveInside, toRel } from "./files.js";

const { rawFile, gallery, shoot } = tables;

export interface PendingRaw {
  id: string;
  relPath: string;
  file: string;
  sizeBytes: number;
}

export interface RemoteRaw extends PendingRaw {
  remoteKey: string;
  mtimeMs: number;
}

const MAX_DEPTH = 8;

/**
 * Files in each shoot's Originals/RAW folder. They never become gallery photos and are never shown to clients;
 * they are tracked so an extension can move them to remote storage and bring them back. Same contract as
 * {@link Originals}: the extension uploads and checks a copy, then calls `markRemote`, which frees the local file.
 */
export class RawFiles {
  constructor(private readonly deps: { db: Db; galleriesDir: string; rawSubdir: () => string }) {}

  /** Shoot folders worth looking in: every gallery's, and every shoot that has a folder. */
  private shootFolders(): string[] {
    const { db } = this.deps;
    const fromGalleries = db.select({ f: gallery.shootFolder }).from(gallery).all().map((r) => r.f);
    const fromShoots = db.select({ f: shoot.folderPath }).from(shoot).where(isNotNull(shoot.folderPath)).all().map((r) => r.f!);
    return [...new Set([...fromGalleries, ...fromShoots])].filter(Boolean);
  }

  private walk(dir: string, depth: number, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !isIgnoredName(e.name)) this.walk(p, depth + 1, out);
      } else if (e.isFile() && isTrackableFile(e.name)) out.push(p);
    }
  }

  /** Brings the table in step with what is on disk. Files already in remote storage are left alone. */
  scan(): { added: number; changed: number; removed: number } {
    const { db, galleriesDir } = this.deps;
    const result = { added: 0, changed: 0, removed: 0 };
    const sub = this.deps.rawSubdir().replace(/^\/+|\/+$/g, "");
    if (!sub || !fs.existsSync(galleriesDir)) return result;
    for (const folder of this.shootFolders()) {
      let root: string;
      try {
        root = resolveInside(galleriesDir, `${folder}/${sub}`);
      } catch {
        continue;
      }
      const files: string[] = [];
      if (fs.existsSync(root)) this.walk(root, 0, files);
      const seen = new Set<string>();
      for (const abs of files) {
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        const rel = toRel(galleriesDir, abs);
        seen.add(rel);
        const row = db.select().from(rawFile).where(eq(rawFile.relPath, rel)).get();
        const mtimeMs = Math.floor(st.mtimeMs);
        if (!row) {
          db.insert(rawFile).values({ id: crypto.randomUUID(), shootFolder: folder, relPath: rel, filename: path.basename(abs), sizeBytes: st.size, mtimeMs }).run();
          result.added++;
        } else if (!row.remoteKey && (row.sizeBytes !== st.size || row.mtimeMs !== mtimeMs || row.missingSince)) {
          db.update(rawFile).set({ sizeBytes: st.size, mtimeMs, missingSince: null, updatedAt: new Date() }).where(eq(rawFile.id, row.id)).run();
          result.changed++;
        }
      }
      // A file that has gone and was never moved is just forgotten. One that was moved is expected to be absent.
      for (const row of db.select().from(rawFile).where(and(eq(rawFile.shootFolder, folder), isNull(rawFile.remoteKey))).all()) {
        if (!seen.has(row.relPath)) {
          db.delete(rawFile).where(eq(rawFile.id, row.id)).run();
          result.removed++;
        }
      }
    }
    return result;
  }

  private localPath(rel: string): string | null {
    try {
      const file = resolveInside(this.deps.galleriesDir, rel);
      return fs.existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }

  /**
   * Local files that are ready to move: unchanged for `settleMs`. A gallery set to "local" is never offered,
   * "offsite" always is, and "default" follows `defaultOffsite`, the studio-wide choice.
   */
  pending(limit: number, settleMs = 10 * 60_000, defaultOffsite = true): PendingRaw[] {
    const rows = this.deps.db
      .select({ r: rawFile })
      .from(rawFile)
      .leftJoin(gallery, eq(gallery.shootFolder, rawFile.shootFolder))
      .where(
        and(
          isNull(rawFile.remoteKey),
          lt(rawFile.mtimeMs, Date.now() - settleMs),
          defaultOffsite ? sql`coalesce(${gallery.storageOriginals}, 'default') != 'local'` : sql`${gallery.storageOriginals} = 'offsite'`,
        ),
      )
      .limit(limit * 4)
      .all()
      .map((r) => r.r);
    const out: PendingRaw[] = [];
    for (const r of rows) {
      const file = this.localPath(r.relPath);
      if (!file) continue;
      out.push({ id: r.id, relPath: r.relPath, file, sizeBytes: r.sizeBytes });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The file is safely stored and checked: remember where, and free the local copy. Refuses if it changed. */
  markRemote(id: string, key: string, expect: { sizeBytes: number }): boolean {
    const r = this.deps.db.select().from(rawFile).where(eq(rawFile.id, id)).get();
    if (!r || r.sizeBytes !== expect.sizeBytes) return false;
    const file = this.localPath(r.relPath);
    if (file && fs.statSync(file).size !== expect.sizeBytes) return false;
    this.deps.db.update(rawFile).set({ remoteKey: key, updatedAt: new Date() }).where(eq(rawFile.id, r.id)).run();
    if (file) fs.rmSync(file, { force: true });
    return true;
  }

  /** Files held in remote storage, optionally just one shoot's, for bringing them back. */
  remote(limit: number, shootFolder?: string): RemoteRaw[] {
    return this.deps.db
      .select()
      .from(rawFile)
      .where(shootFolder === undefined ? isNotNull(rawFile.remoteKey) : and(isNotNull(rawFile.remoteKey), eq(rawFile.shootFolder, shootFolder)))
      .limit(limit)
      .all()
      .map((r) => ({ id: r.id, remoteKey: r.remoteKey!, relPath: r.relPath, file: resolveInside(this.deps.galleriesDir, r.relPath), sizeBytes: r.sizeBytes, mtimeMs: r.mtimeMs }));
  }

  /** Files held in remote storage although their gallery was set to keep the Originals folder on this server. */
  wantedLocal(limit: number): RemoteRaw[] {
    return this.deps.db
      .select({ r: rawFile })
      .from(rawFile)
      .innerJoin(gallery, eq(gallery.shootFolder, rawFile.shootFolder))
      .where(and(isNotNull(rawFile.remoteKey), eq(gallery.storageOriginals, "local")))
      .limit(limit)
      .all()
      .map((x) => x.r)
      .map((r) => ({ id: r.id, remoteKey: r.remoteKey!, relPath: r.relPath, file: resolveInside(this.deps.galleriesDir, r.relPath), sizeBytes: r.sizeBytes, mtimeMs: r.mtimeMs }));
  }

  /** The file is back on disk (the extension wrote and checked it): stop pointing at remote storage. */
  markLocal(id: string): boolean {
    const r = this.deps.db.select().from(rawFile).where(eq(rawFile.id, id)).get();
    if (!r) return false;
    const file = this.localPath(r.relPath);
    if (!file || fs.statSync(file).size !== r.sizeBytes) return false;
    this.deps.db.update(rawFile).set({ remoteKey: null, mtimeMs: Math.floor(fs.statSync(file).mtimeMs), updatedAt: new Date() }).where(eq(rawFile.id, r.id)).run();
    return true;
  }

  counts(shootFolder?: string): { local: number; remote: number; localBytes: number; remoteBytes: number } {
    const row = this.deps.db
      .select({
        remote: sql<number>`coalesce(sum(case when ${rawFile.remoteKey} is not null then 1 else 0 end), 0)`,
        remoteBytes: sql<number>`coalesce(sum(case when ${rawFile.remoteKey} is not null then ${rawFile.sizeBytes} else 0 end), 0)`,
        total: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${rawFile.sizeBytes}), 0)`,
      })
      .from(rawFile)
      .where(shootFolder === undefined ? undefined : eq(rawFile.shootFolder, shootFolder))
      .get();
    const remote = row?.remote ?? 0;
    const remoteBytes = row?.remoteBytes ?? 0;
    return { local: (row?.total ?? 0) - remote, remote, localBytes: (row?.totalBytes ?? 0) - remoteBytes, remoteBytes };
  }

  remoteUsage(): Array<{ relPath: string; sizeBytes: number; mtimeMs: number }> {
    return this.deps.db.select({ relPath: rawFile.relPath, sizeBytes: rawFile.sizeBytes, mtimeMs: rawFile.mtimeMs }).from(rawFile).where(isNotNull(rawFile.remoteKey)).all();
  }
}
