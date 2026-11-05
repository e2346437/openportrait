import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import { resolveInside } from "./files.js";
import { RawFiles } from "./raw.js";
import { DEFAULT_RAW_SUBDIR } from "../domain/folders.js";

const { photo, gallery } = tables;
type Photo = typeof tables.photo.$inferSelect;

/**
 * Somewhere other than the local disk that holds the full-size originals. The app ships without one; an
 * extension registers it. Previews and thumbnails always stay on local disk, so a gallery browses at full speed
 * and the store is only read when someone downloads a full-resolution file.
 *
 * Nothing here is public: bytes only leave through the app's own gallery checks (sign-in, gallery code,
 * payment lock), never through a public link to the store.
 */
export interface OriginalStore {
  get(key: string): Promise<{ stream: Readable; size: number }>;
  delete(key: string): Promise<void>;
}

export class OriginalUnavailableError extends Error {
  constructor() {
    super("This photo's original is in remote storage, which is not available right now.");
  }
}

export interface RemoteOriginal {
  id: string;
  remoteKey: string;
  /** Where the file belongs when it comes back to the galleries folder. */
  file: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface PendingOriginal {
  id: string;
  relPath: string;
  file: string;
  sizeBytes: number;
  contentHash: string;
}

/** Where a photo's original is read from. Local files win; the registered store is the fallback. */
export class Originals {
  private store: OriginalStore | null = null;

  /** Files in each shoot's Originals/RAW folder, tracked the same way so they can be moved too. */
  readonly raw: RawFiles;

  constructor(
    private readonly deps: { db: Db; galleriesDir: string; rawSubdir?: () => string },
  ) {
    this.raw = new RawFiles({ db: deps.db, galleriesDir: deps.galleriesDir, rawSubdir: deps.rawSubdir ?? (() => DEFAULT_RAW_SUBDIR) });
  }

  /** An extension calls this with its store, or with null to detach it. Files already in the store stay there. */
  setStore(store: OriginalStore | null): void {
    this.store = store;
  }

  hasStore(): boolean {
    return this.store !== null;
  }

  private localPath(p: Pick<Photo, "relPath">): string | null {
    try {
      const file = resolveInside(this.deps.galleriesDir, p.relPath);
      return fs.existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }

  /** Opens the full-size file for streaming. Throws OriginalUnavailableError if it is remote and the store is off. */
  async open(p: Pick<Photo, "relPath" | "remoteKey" | "sizeBytes">): Promise<{ stream: Readable; size: number }> {
    const local = this.localPath(p);
    if (local) return { stream: fs.createReadStream(local), size: fs.statSync(local).size };
    if (!p.remoteKey || !this.store) throw new OriginalUnavailableError();
    return this.store.get(p.remoteKey);
  }

  /**
   * Checks, before a zip starts, that every file can be read. Local files are checked on disk; for the ones in
   * the store, the store must be attached and one of them is opened as a probe, which catches an outage without
   * a request per photo. Returns the first problem, or null.
   */
  async unreachable(photos: Array<Pick<Photo, "id" | "relPath" | "remoteKey" | "sizeBytes">>): Promise<{ photo: string; reason: "store_off" | "store_error" } | null> {
    let probe: (typeof photos)[number] | null = null;
    for (const p of photos) {
      if (this.localPath(p)) continue;
      if (!p.remoteKey || !this.store) return { photo: p.id, reason: "store_off" };
      probe ??= p;
    }
    if (!probe) return null;
    try {
      const { stream } = await this.store!.get(probe.remoteKey!);
      stream.destroy();
    } catch {
      return { photo: probe.id, reason: "store_error" };
    }
    return null;
  }

  /** A local file path to work from (for resizing). Remote originals are fetched to a temp file; call cleanup() when done. */
  async materialize(p: Pick<Photo, "relPath" | "remoteKey" | "sizeBytes">): Promise<{ file: string; cleanup: () => void }> {
    const local = this.localPath(p);
    if (local) return { file: local, cleanup: () => {} };
    const { stream } = await this.open(p);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-original-"));
    const file = path.join(dir, path.basename(p.relPath));
    try {
      await pipeline(stream, fs.createWriteStream(file));
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  /** Deletes a photo's original everywhere: the local file and, if it was offloaded, the stored copy. */
  async remove(p: Pick<Photo, "relPath" | "remoteKey">): Promise<void> {
    if (p.remoteKey) {
      if (!this.store) throw new OriginalUnavailableError();
      await this.store.delete(p.remoteKey);
    }
    fs.rmSync(resolveInside(this.deps.galleriesDir, p.relPath), { force: true });
  }

  /** Forgets a stored copy that a changed local file replaced. Best effort. */
  async dropRemote(key: string): Promise<void> {
    try {
      await this.store?.delete(key);
    } catch {
      /* an orphaned object is harmless; the extension can reconcile it */
    }
  }

  /**
   * Local originals that are ready to move: previews exist, and the file has not changed for `settleMs`.
   * The extension uploads each one, checks it, then calls markRemote.
   */
  pending(limit: number, settleMs = 10 * 60_000, defaultOffsite = true): PendingOriginal[] {
    // A gallery set to "local" is never offered; "offsite" always is; "default" follows the studio-wide choice.
    const rows = this.deps.db
      .select({ p: photo })
      .from(photo)
      .innerJoin(gallery, eq(photo.galleryId, gallery.id))
      .where(
        and(
          eq(photo.state, "ready"),
          isNull(photo.remoteKey),
          lt(photo.mtimeMs, Date.now() - settleMs),
          defaultOffsite ? sql`${gallery.storageGallery} != 'local'` : sql`${gallery.storageGallery} = 'offsite'`,
        ),
      )
      .limit(limit * 4)
      .all()
      .map((r) => r.p);
    const out: PendingOriginal[] = [];
    for (const p of rows) {
      const file = this.localPath(p);
      if (!file) continue;
      out.push({ id: p.id, relPath: p.relPath, file, sizeBytes: p.sizeBytes, contentHash: p.contentHash });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Records that a photo's original is safely in the store and frees the local file. The extension must have
   * checked the stored copy first. Refuses if the file changed since it was listed, so a re-export is never lost.
   */
  markRemote(photoId: string, key: string, expect: { sizeBytes: number }): boolean {
    const p = this.deps.db.select().from(photo).where(eq(photo.id, photoId)).get();
    if (!p || p.sizeBytes !== expect.sizeBytes) return false;
    const file = this.localPath(p);
    if (file && fs.statSync(file).size !== expect.sizeBytes) return false;
    this.deps.db.update(photo).set({ remoteKey: key, updatedAt: new Date() }).where(eq(photo.id, p.id)).run();
    if (file) fs.rmSync(file, { force: true });
    return true;
  }

  /** Photos whose original is in the store, for bringing them back to the galleries folder. */
  remote(limit: number, shootFolder?: string): RemoteOriginal[] {
    return this.deps.db
      .select({ p: photo })
      .from(photo)
      .innerJoin(gallery, eq(photo.galleryId, gallery.id))
      .where(shootFolder === undefined ? isNotNull(photo.remoteKey) : and(isNotNull(photo.remoteKey), eq(gallery.shootFolder, shootFolder)))
      .limit(limit)
      .all()
      .map((r) => r.p)
      .map((p) => ({ id: p.id, remoteKey: p.remoteKey!, file: resolveInside(this.deps.galleriesDir, p.relPath), sizeBytes: p.sizeBytes, mtimeMs: p.mtimeMs }));
  }

  /** The original is back in the galleries folder (the extension wrote and checked it): stop pointing at the store. */
  markLocal(photoId: string): boolean {
    const p = this.deps.db.select().from(photo).where(eq(photo.id, photoId)).get();
    if (!p) return false;
    const file = this.localPath(p);
    if (!file || fs.statSync(file).size !== p.sizeBytes) return false;
    this.deps.db.update(photo).set({ remoteKey: null, updatedAt: new Date() }).where(eq(photo.id, p.id)).run();
    return true;
  }

  /** How many originals are local and how many are in the store, with their sizes in bytes. */
  counts(shootFolder?: string): { local: number; remote: number; localBytes: number; remoteBytes: number } {
    const row = this.deps.db
      .select({
        remote: sql<number>`coalesce(sum(case when ${photo.remoteKey} is not null then 1 else 0 end), 0)`,
        remoteBytes: sql<number>`coalesce(sum(case when ${photo.remoteKey} is not null then ${photo.sizeBytes} else 0 end), 0)`,
        total: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${photo.sizeBytes}), 0)`,
      })
      .from(photo)
      .where(shootFolder === undefined ? undefined : sql`${photo.galleryId} in (select ${gallery.id} from ${gallery} where ${gallery.shootFolder} = ${shootFolder})`)
      .get();
    const remote = row?.remote ?? 0;
    const remoteBytes = row?.remoteBytes ?? 0;
    return { local: (row?.total ?? 0) - remote, remote, localBytes: (row?.totalBytes ?? 0) - remoteBytes, remoteBytes };
  }

  /** Every original in the store: its path in the galleries folder and its size, for usage charts. */
  remoteUsage(): Array<{ relPath: string; sizeBytes: number; mtimeMs: number }> {
    return this.deps.db
      .select({ relPath: photo.relPath, sizeBytes: photo.sizeBytes, mtimeMs: photo.mtimeMs })
      .from(photo)
      .where(isNotNull(photo.remoteKey))
      .all();
  }
}
