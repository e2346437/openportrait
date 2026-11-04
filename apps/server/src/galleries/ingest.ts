import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import { enqueue, type Logger } from "@openportrait/jobs";
import { DEFAULT_RULES, discover, listGalleryFiles, type FolderRules } from "./discover.js";
import { newId, resolveInside, sha256File, slugify, titleFromFolder } from "./files.js";
import type { Originals } from "./originals.js";
import type { Settings } from "../settings.js";

const { gallery, gallerySet, photo, ingestFolder, favoriteList, shoot, shootType } = tables;

/** Photos missing from disk this long are deleted, with their favorites. */
export const MISSING_PURGE_MS = 30 * 86_400_000;
/** Name of the set for photos loose in the gallery root. */
export const LOOSE_SET_NAME = "Photos";
const SAMPLE_COUNT = 6;

export interface ScanResult {
  galleries: number;
  added: number;
  changed: number;
  missing: number;
  /** Files still being written; a follow-up scan picks them up. */
  waiting: number;
  unmatched: number;
}

export interface IngestDeps {
  db: Db;
  settings: Settings;
  galleriesDir: string;
  settleSeconds: number;
  logger: Logger;
}

export const DERIVATIVES_JOB = "gallery.derivatives";

export function folderRules(settings: Settings): FolderRules {
  return {
    deliveryFolder: settings.get("galleries.deliveryFolder") || DEFAULT_RULES.deliveryFolder,
    privateFolders: settings.get("galleries.privateFolders") ?? DEFAULT_RULES.privateFolders,
  };
}

/**
 * Keeps the database in step with the gallery share (docs/GALLERIES.md section 3):
 * folders that belong to a gallery sync their sets and photos, everything else lands in the
 * Unmatched folders inbox. Safe to call at any time; overlapping calls share one scan.
 */
export class GalleryIngest {
  private running: Promise<ScanResult> | null = null;
  private again = false;
  private followUp: NodeJS.Timeout | null = null;

  private originals: Originals | null = null;

  constructor(private readonly deps: IngestDeps) {}

  setOriginals(originals: Originals): void {
    this.originals = originals;
  }

  scan(): Promise<ScanResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let result: ScanResult;
      do {
        this.again = false;
        result = await this.scanOnce();
      } while (this.again);
      return result;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Stops any follow-up scan that is waiting for files to settle. */
  close(): void {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
  }

  private async scanOnce(): Promise<ScanResult> {
    const { db, galleriesDir } = this.deps;
    const result: ScanResult = { galleries: 0, added: 0, changed: 0, missing: 0, waiting: 0, unmatched: 0 };
    if (!fs.existsSync(galleriesDir)) return result;
    const rules = folderRules(this.deps.settings);
    const candidates = discover(galleriesDir, rules);
    const seenFolders = new Set<string>();

    for (const c of candidates) {
      seenFolders.add(c.shootFolder);
      const g = db.select().from(gallery).where(eq(gallery.shootFolder, c.shootFolder)).get();
      if (g) {
        if (g.folderPath !== c.root || g.sourceMissing) {
          db.update(gallery).set({ folderPath: c.root, sourceMissing: false, updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
        }
        const r = await this.syncGallery(g.id);
        result.galleries++;
        result.added += r.added;
        result.changed += r.changed;
        result.missing += r.missing;
        result.waiting += r.waiting;
      } else {
        if (this.upsertInbox(c.shootFolder, c.root)) {
          // A folder that belongs to a shoot in the CRM becomes its gallery as soon as it has stopped changing.
          const row = db.select().from(ingestFolder).where(eq(ingestFolder.relPath, c.shootFolder)).get();
          if (row && row.state === "unmatched" && row.stable && this.matchShoot(c.shootFolder)) {
            await this.createFromFolder(row.id);
            result.galleries++;
          } else {
            result.unmatched++;
          }
        }
      }
    }

    // Galleries whose folder is gone stay in the app (favorites, history) and say so.
    for (const g of db.select({ id: gallery.id, shootFolder: gallery.shootFolder, sourceMissing: gallery.sourceMissing }).from(gallery).all()) {
      if (seenFolders.has(g.shootFolder)) continue;
      const exists = fs.existsSync(resolveInside(galleriesDir, g.shootFolder));
      if (!exists && !g.sourceMissing) db.update(gallery).set({ sourceMissing: true, updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
      if (exists) {
        // The folder is there but has no photos right now (e.g. mid re-export): sync marks them missing.
        const r = await this.syncGallery(g.id);
        result.missing += r.missing;
      }
    }

    // Inbox entries for folders that disappeared (moved, renamed, emptied) go away; ignored ones are kept so they stay ignored.
    const stale = db
      .select({ id: ingestFolder.id, relPath: ingestFolder.relPath })
      .from(ingestFolder)
      .where(eq(ingestFolder.state, "unmatched"))
      .all()
      .filter((f) => !seenFolders.has(f.relPath));
    if (stale.length) db.delete(ingestFolder).where(inArray(ingestFolder.id, stale.map((f) => f.id))).run();

    // Photos missing for a month are gone for good.
    db.delete(photo)
      .where(and(eq(photo.state, "missing"), isNotNull(photo.missingSince), lt(photo.missingSince, new Date(Date.now() - MISSING_PURGE_MS))))
      .run();

    if (result.waiting > 0) this.scheduleFollowUp();
    return result;
  }

  private scheduleFollowUp(): void {
    if (this.followUp) return;
    this.followUp = setTimeout(() => {
      this.followUp = null;
      this.scan().catch((err) => this.deps.logger.error({ err: String(err) }, "gallery rescan failed"));
    }, (this.deps.settleSeconds + 1) * 1000);
    this.followUp.unref();
  }

  /** The shoot whose folder this is, if any. */
  private matchShoot(relPath: string) {
    return this.deps.db
      .select({ id: shoot.id, subject: shoot.subject, autoPublish: shootType.autoPublish })
      .from(shoot)
      .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
      .where(sql`lower(${shoot.folderPath}) = ${relPath.toLowerCase()}`)
      .get();
  }

  /** Records (or refreshes) a folder in the Unmatched inbox. Returns true when it is waiting for the studio. */
  private upsertInbox(shootFolder: string, root: string): boolean {
    const { db, galleriesDir } = this.deps;
    const files = [...listGalleryFiles(galleriesDir, root).values()].flat();
    const existing = db.select().from(ingestFolder).where(eq(ingestFolder.relPath, shootFolder)).get();
    const samples = files.slice(0, SAMPLE_COUNT);
    let newest = 0;
    for (const f of files) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(galleriesDir, f)).mtimeMs);
      } catch {
        /* vanished mid-scan */
      }
    }
    const stable = Date.now() - newest >= this.deps.settleSeconds * 1000;
    if (!existing) {
      db.insert(ingestFolder).values({ id: newId(), relPath: shootFolder, fileCount: files.length, sampleFiles: samples, stable, lastChangeAt: new Date(newest || Date.now()) }).run();
      return true;
    }
    if (existing.state === "matched") {
      // Its gallery was deleted: the folder is back in the inbox.
      db.update(ingestFolder).set({ state: "unmatched", galleryId: null, fileCount: files.length, sampleFiles: samples, stable }).where(eq(ingestFolder.id, existing.id)).run();
      return true;
    }
    if (existing.fileCount !== files.length || existing.stable !== stable) {
      db.update(ingestFolder)
        .set({ fileCount: files.length, sampleFiles: samples, stable, lastChangeAt: new Date(newest || Date.now()) })
        .where(eq(ingestFolder.id, existing.id))
        .run();
    }
    return existing.state === "unmatched";
  }

  /** Brings one gallery's sets and photos in line with its folder. */
  async syncGallery(galleryId: string): Promise<{ added: number; changed: number; missing: number; waiting: number }> {
    const { db, galleriesDir, settleSeconds } = this.deps;
    const out = { added: 0, changed: 0, missing: 0, waiting: 0 };
    const g = db.select().from(gallery).where(eq(gallery.id, galleryId)).get();
    if (!g) return out;
    const files = fs.existsSync(resolveInside(galleriesDir, g.folderPath)) ? listGalleryFiles(galleriesDir, g.folderPath) : new Map<string, string[]>();

    const sets = new Map(db.select().from(gallerySet).where(eq(gallerySet.galleryId, g.id)).all().map((s) => [s.folderName, s]));
    let nextSort = Math.max(-1, ...[...sets.values()].map((s) => s.sort)) + 1;
    const folderNames = [...files.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    for (const folderName of folderNames) {
      if (sets.has(folderName)) continue;
      const row = { id: newId(), galleryId: g.id, name: folderName || LOOSE_SET_NAME, folderName, sort: nextSort++ };
      db.insert(gallerySet).values(row).run();
      sets.set(folderName, { ...row, hidden: false, earlyDownload: false, coverPhotoId: null, coverFocalX: 50, coverFocalY: 50 });
    }

    const existing = db.select().from(photo).where(eq(photo.galleryId, g.id)).all();
    const byPath = new Map(existing.map((p) => [p.relPath, p]));
    const seen = new Set<string>();
    const now = Date.now();

    for (const [folderName, relPaths] of files) {
      const set = sets.get(folderName)!;
      for (const relPath of relPaths) {
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(galleriesDir, relPath));
        } catch {
          continue;
        }
        const prev = byPath.get(relPath);
        if (prev && prev.sizeBytes === st.size && prev.mtimeMs === Math.round(st.mtimeMs)) {
          seen.add(prev.id);
          if (prev.state === "missing" || prev.setId !== set.id) {
            db.update(photo).set({ state: prev.width ? "ready" : "pending", missingSince: null, setId: set.id, updatedAt: new Date() }).where(eq(photo.id, prev.id)).run();
            if (!prev.width) this.queueDerivatives(prev.id, prev.version);
          }
          continue;
        }
        // Lightroom and Aftershoot write in place; wait until the file stops changing.
        if (now - st.mtimeMs < settleSeconds * 1000) {
          if (prev) seen.add(prev.id);
          out.waiting++;
          continue;
        }
        const contentHash = await sha256File(path.join(galleriesDir, relPath));
        if (prev) {
          seen.add(prev.id);
          const same = prev.contentHash === contentHash;
          const version = same ? prev.version : prev.version + 1;
          db.update(photo)
            .set({ sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), contentHash, version, setId: set.id, state: same && prev.width ? (prev.state === "missing" ? "ready" : prev.state) : "pending", missingSince: null, updatedAt: new Date() })
            .where(eq(photo.id, prev.id))
            .run();
          if (!same) {
            // A new local file replaces anything an extension had moved to remote storage.
            if (prev.remoteKey) {
              db.update(photo).set({ remoteKey: null }).where(eq(photo.id, prev.id)).run();
              void this.originals?.dropRemote(prev.remoteKey);
            }
            out.changed++;
            this.queueDerivatives(prev.id, version);
          }
          continue;
        }
        // A file we have never seen at this path: maybe a rename or move of a photo that just went missing.
        const moved = existing.find((p) => !seen.has(p.id) && p.contentHash === contentHash && (p.state === "missing" || !fs.existsSync(path.join(galleriesDir, p.relPath))));
        if (moved) {
          seen.add(moved.id);
          byPath.delete(moved.relPath);
          db.update(photo)
            .set({ relPath, filename: path.basename(relPath), setId: set.id, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), state: moved.width ? "ready" : "pending", missingSince: null, updatedAt: new Date() })
            .where(eq(photo.id, moved.id))
            .run();
          if (!moved.width) this.queueDerivatives(moved.id, moved.version);
          continue;
        }
        const id = newId();
        // A path can be taken by a photo from another gallery when folders were reorganised; that row moves here.
        db.delete(photo).where(and(eq(photo.relPath, relPath), eq(photo.state, "missing"))).run();
        db.insert(photo)
          .values({ id, galleryId: g.id, setId: set.id, relPath, filename: path.basename(relPath), contentHash, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) })
          .onConflictDoNothing()
          .run();
        seen.add(id);
        out.added++;
        this.queueDerivatives(id, 1);
      }
    }

    for (const p of existing) {
      if (seen.has(p.id) || p.state === "missing" || p.remoteKey) continue; // offloaded originals have no local file by design
      db.update(photo).set({ state: "missing", missingSince: new Date(), updatedAt: new Date() }).where(eq(photo.id, p.id)).run();
      out.missing++;
    }

    // Sets whose folder is gone and that hold nothing at all are removed; ones with missing photos wait for the purge.
    for (const s of sets.values()) {
      if (files.has(s.folderName)) continue;
      const any = db.select({ id: photo.id }).from(photo).where(eq(photo.setId, s.id)).get();
      if (!any) db.delete(gallerySet).where(eq(gallerySet.id, s.id)).run();
    }

    if (out.added || out.changed || out.missing) db.update(gallery).set({ updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
    return out;
  }

  private queueDerivatives(photoId: string, version: number): void {
    enqueue(this.deps.db, DERIVATIVES_JOB, { photoId, version }, { dedupeKey: `derivatives:${photoId}:${version}` });
  }

  /** Turns an Unmatched inbox folder into a draft gallery and imports its photos. */
  async createFromFolder(folderId: string, opts: { title?: string; downloadLock?: "until_paid" | "highlights_early" | "none" } = {}): Promise<string | null> {
    const { db, galleriesDir } = this.deps;
    const folder = db.select().from(ingestFolder).where(eq(ingestFolder.id, folderId)).get();
    if (!folder) return null;
    const already = db.select({ id: gallery.id }).from(gallery).where(eq(gallery.shootFolder, folder.relPath)).get();
    if (already) return already.id;

    const rules = folderRules(this.deps.settings);
    const abs = resolveInside(galleriesDir, folder.relPath);
    const delivery = fs.existsSync(abs) ? fs.readdirSync(abs).find((n) => n.localeCompare(rules.deliveryFolder, undefined, { sensitivity: "accent" }) === 0) : undefined;
    const root = delivery ? `${folder.relPath}/${delivery}` : folder.relPath;
    const match = this.matchShoot(folder.relPath);
    const title = opts.title?.trim() || match?.subject?.trim() || titleFromFolder(path.basename(folder.relPath));
    const id = newId();
    db.transaction((tx) => {
      tx.insert(gallery)
        .values({
          id,
          slug: uniqueSlug(tx as unknown as Db, title),
          title,
          shootFolder: folder.relPath,
          folderPath: root,
          shootId: match?.id ?? null,
          downloadLock: opts.downloadLock ?? this.deps.settings.get("galleries.defaultDownloadLock") ?? "until_paid",
          ...(match?.autoPublish ? { status: "live" as const, publishedAt: new Date() } : {}),
        })
        .run();
      tx.insert(favoriteList).values({ id: newId(), galleryId: id, name: "Favorites", sort: 0 }).run();
      tx.update(ingestFolder).set({ state: "matched", galleryId: id }).where(eq(ingestFolder.id, folder.id)).run();
    });
    await this.syncGallery(id);
    return id;
  }
}

/**
 * "smith-family-" plus 128 random bits (26 base32 characters), so a link can't be guessed or enumerated (SEC-005).
 * Links made before this change keep working; only new galleries get the longer tail.
 */
export function uniqueSlug(db: Db, title: string): string {
  const base = slugify(title).slice(0, 40).replace(/-+$/, "") || "gallery";
  for (;;) {
    const candidate = `${base}-${base32(randomBytes(16))}`;
    if (!db.select({ id: gallery.id }).from(gallery).where(eq(gallery.slug, candidate)).get()) return candidate;
  }
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
