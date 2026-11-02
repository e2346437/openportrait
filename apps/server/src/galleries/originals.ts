import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, isNull, lt } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import { resolveInside } from "./files.js";

const { photo } = tables;
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

  constructor(
    private readonly deps: { db: Db; galleriesDir: string },
  ) {}

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
  pending(limit: number, settleMs = 10 * 60_000): PendingOriginal[] {
    const rows = this.deps.db
      .select()
      .from(photo)
      .where(and(eq(photo.state, "ready"), isNull(photo.remoteKey), lt(photo.mtimeMs, Date.now() - settleMs)))
      .limit(limit * 4)
      .all();
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
}
