import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { ZipArchive } from "archiver";
import { tables, type Db } from "@openportrait/db";
import { derivativePath, renderVariant, WEB_QUALITY } from "./derivatives.js";
import { downloadState, loadSetsAndPhotos } from "./present.js";
import type { Originals } from "./originals.js";
import { LOOSE_SET_NAME } from "./ingest.js";

const { favoriteSelection, favoriteItem, favoriteList } = tables;
type Gallery = typeof tables.gallery.$inferSelect;
type Photo = typeof tables.photo.$inferSelect;
type GallerySet = typeof tables.gallerySet.$inferSelect;

/** One zip part stays under this, so every part downloads on any browser or phone. */
export const MAX_PART_BYTES = 2 * 1024 ** 3;
/** Web-size JPEGs are about this big; used to size parts before they are made. */
const WEB_ESTIMATE = 1_200_000;

export type Scope = { kind: "gallery" } | { kind: "set"; setId: string } | { kind: "favorites"; listId: string; email: string };

export interface Entry {
  photo: Photo;
  /** Path inside the zip. */
  name: string;
  bytes: number;
}

/** The photos a visitor may download for this scope right now, with their paths in the zip. Locked sets are left out. */
export function planZip(db: Db, g: Gallery, scope: Scope): { entries: Entry[]; label: string } {
  const { sets, photos } = loadSetsAndPhotos(db, g.id);
  const setById = new Map<string, GallerySet>(sets.map((s) => [s.id, s]));
  const visible = (p: Photo) => p.state === "ready" && !p.hidden && !!setById.get(p.setId) && !setById.get(p.setId)!.hidden;
  const allowed = (p: Photo) => downloadState(g, setById.get(p.setId) ?? null).allowed;
  let chosen: Photo[];
  let label = g.title;
  if (scope.kind === "set") {
    chosen = photos.filter((p) => p.setId === scope.setId);
    label = `${g.title} - ${setById.get(scope.setId)?.name ?? "set"}`;
  } else if (scope.kind === "favorites") {
    const sel = db.select().from(favoriteSelection).where(and(eq(favoriteSelection.listId, scope.listId), eq(favoriteSelection.clientEmail, scope.email))).get();
    const ids = sel ? db.select({ id: favoriteItem.photoId }).from(favoriteItem).where(eq(favoriteItem.selectionId, sel.id)).all().map((r) => r.id) : [];
    const list = db.select().from(favoriteList).where(eq(favoriteList.id, scope.listId)).get();
    const set = new Set(ids);
    chosen = photos.filter((p) => set.has(p.id));
    label = `${g.title} - ${list?.name ?? "favorites"}`;
  } else {
    chosen = photos;
  }
  const keep = chosen.filter((p) => visible(p) && allowed(p));
  const used = new Set<string>();
  const entries = keep.map((p) => {
    const set = setById.get(p.setId)!;
    const dir = scope.kind === "gallery" && set.folderName !== "" && set.name !== LOOSE_SET_NAME ? `${safe(set.name)}/` : "";
    const filename = g.downloadSize === "web" ? p.filename.replace(/\.[^.]+$/, "") + ".jpg" : p.filename;
    let name = dir + filename;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${dir}${filename.replace(/(\.[^.]+)$/, ` (${n})$1`)}`;
    used.add(name.toLowerCase());
    return { photo: p, name, bytes: g.downloadSize === "web" ? WEB_ESTIMATE : p.sizeBytes };
  });
  return { entries, label };
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "folder";

/** Splits a list into parts that each stay under the size limit. A single huge file gets its own part. */
export function splitParts(entries: Entry[], max = MAX_PART_BYTES): Entry[][] {
  const parts: Entry[][] = [];
  let cur: Entry[] = [];
  let size = 0;
  for (const e of entries) {
    if (cur.length && size + e.bytes > max) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += e.bytes;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** Streams one part as a zip. JPEGs don't shrink, so files are stored as they are, which keeps it fast and light on the server. */
export function streamZip(opts: { originals: Originals; cacheDir: string; webQuality?: number; gallery: Gallery; entries: Entry[]; onError: (err: Error) => void }) {
  const archive = new ZipArchive({ store: true, forceZip64: true });
  archive.on("error", (err) => {
    opts.onError(err);
    archive.abort();
  });
  const quality = opts.webQuality ?? WEB_QUALITY.default;
  archive.on("warning", (w: { code?: string } & Error) => w.code !== "ENOENT" && opts.onError(w));
  void (async () => {
    for (const e of opts.entries) {
      if (archive.destroyed) return;
      try {
        const date = new Date(e.photo.mtimeMs);
        if (opts.gallery.downloadSize === "web") {
          const file = derivativePath(opts.cacheDir, opts.gallery.id, e.photo.id, e.photo.version, "web", quality);
          if (!fs.existsSync(file)) {
            const src = await opts.originals.materialize(e.photo);
            try {
              await renderVariant(src.file, file, "web", quality);
            } finally {
              src.cleanup();
            }
          }
          archive.file(file, { name: e.name, date });
        } else {
          const { stream } = await opts.originals.open(e.photo);
          archive.append(stream, { name: e.name, date });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // moved away since the last scan
        // Any other failure (the store went away mid-zip): stop, so the browser sees a failed download
        // instead of a "finished" zip that is quietly missing photos.
        opts.onError(err as Error);
        archive.abort();
        return;
      }
    }
    void archive.finalize();
  })();
  return archive;
}

export const zipFilename = (label: string, part: number, parts: number) => `${safe(label).slice(0, 80)}${parts > 1 ? ` (part ${part} of ${parts})` : ""}.zip`;
