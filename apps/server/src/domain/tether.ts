import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

/** Camera files the live view can show: plain images, or RAW files that carry an embedded JPEG preview. */
const DIRECT = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);
const RAW = new Set([".nef", ".nrw", ".cr2", ".cr3", ".crw", ".arw", ".sr2", ".srf", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw", ".3fr", ".iiq", ".x3f", ".rwl", ".heic", ".heif", ".hif"]);

export function isPhotoFile(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~")) return false;
  const ext = path.extname(name).toLowerCase();
  return DIRECT.has(ext) || RAW.has(ext);
}

export interface SeenFile {
  /** Path relative to the watched folder, with `/` separators. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/** Lists photo files under `root`, skipping the named top-level-or-nested folders (such as the delivery folder). */
export function scanPhotos(root: string, skipDirs: string[] = []): SeenFile[] {
  const out: SeenFile[] = [];
  const skip = new Set(skipDirs.map((d) => d.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")));
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 6 && !e.name.startsWith(".") && !skip.has(childRel)) walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && isPhotoFile(e.name)) {
        try {
          const st = fs.statSync(path.join(dir, e.name));
          out.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  };
  walk(root, "", 0);
  return out;
}

export interface UploadingFile {
  id: string;
  name: string;
  bytes: number;
  /** Bytes per second over the last second or so. */
  rate: number;
  /** Rough percent, estimated from the size of recent files of the same kind. Null when there's nothing to compare with. */
  percent: number | null;
}

export interface LandedPhoto {
  id: string;
  name: string;
  size: number;
  /** When it finished arriving (or, for files already there at start-up, their modified time). */
  at: number;
}

type Tracked = { size: number; mtimeMs: number; changedAt: number; firstSeen: number; startSize: number; state: "uploading" | "landed"; landedAt: number; rate: number; sampleAt: number; sampleSize: number };

export interface TetherEvents {
  onPhoto(photo: LandedPhoto): void;
  onProgress(uploading: UploadingFile[]): void;
}

/**
 * Watches one folder by polling. Polling (rather than inotify) is deliberate: it keeps working on network
 * shares and Unraid user shares, where file-change events are unreliable. A file counts as landed once its
 * size has stopped changing for `settleMs`, which is how a still-growing SFTP upload is told from a finished one.
 */
export class FolderTracker {
  private files = new Map<string, Tracked>();
  private primed = false;
  private lastProgressSent = false;
  private listeners = new Set<TetherEvents>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private root: string,
    private skipDirs: string[],
    private opts: { pollMs: number; settleMs: number } = { pollMs: 1000, settleMs: 1500 },
  ) {}

  subscribe(l: TetherEvents): () => void {
    this.listeners.add(l);
    if (!this.timer) {
      this.tick();
      this.timer = setInterval(() => this.tick(), this.opts.pollMs);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(l);
      if (!this.listeners.size) this.stop();
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get size() {
    return this.listeners.size;
  }

  folderExists(): boolean {
    try {
      return fs.statSync(this.root).isDirectory();
    } catch {
      return false;
    }
  }

  /** The newest finished photo and how many there are, for a viewer that has just connected. */
  snapshot(): { latest: LandedPhoto | null; total: number; uploading: UploadingFile[] } {
    if (!this.primed) this.tick();
    let latest: LandedPhoto | null = null;
    let total = 0;
    for (const [rel, t] of this.files) {
      if (t.state !== "landed") continue;
      total++;
      if (!latest || t.landedAt > latest.at) latest = this.photo(rel, t);
    }
    return { latest, total, uploading: this.uploading() };
  }

  private photo(rel: string, t: Tracked): LandedPhoto {
    return { id: rel, name: path.posix.basename(rel), size: t.size, at: t.landedAt };
  }

  private uploading(): UploadingFile[] {
    const sizes = [...this.files.values()].filter((t) => t.state === "landed").map((t) => t.size).sort((a, b) => a - b);
    const typical = sizes.length >= 3 ? sizes[Math.floor(sizes.length / 2)]! : 0;
    const out: UploadingFile[] = [];
    for (const [rel, t] of this.files) {
      if (t.state !== "uploading") continue;
      out.push({ id: rel, name: path.posix.basename(rel), bytes: t.size, rate: t.rate, percent: typical ? Math.min(99, Math.round((t.size / typical) * 100)) : null });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  tick(now = Date.now()) {
    const seen = new Map(scanPhotos(this.root, this.skipDirs).map((f) => [f.rel, f]));
    for (const rel of this.files.keys()) if (!seen.has(rel)) this.files.delete(rel);

    const landed: Array<[string, Tracked]> = [];
    for (const [rel, f] of seen) {
      let t = this.files.get(rel);
      if (!t) {
        // Files already on disk when we first look were not "just shot": they are history.
        t = { size: f.size, mtimeMs: f.mtimeMs, changedAt: now, firstSeen: now, startSize: f.size, state: this.primed ? "uploading" : "landed", landedAt: this.primed ? 0 : Math.round(f.mtimeMs), rate: 0, sampleAt: now, sampleSize: f.size };
        this.files.set(rel, t);
        continue;
      }
      if (t.state === "landed") {
        // A file that was replaced or grew again goes back to uploading.
        if (f.size !== t.size || f.mtimeMs !== t.mtimeMs) {
          Object.assign(t, { size: f.size, mtimeMs: f.mtimeMs, changedAt: now, state: "uploading", sampleAt: now, sampleSize: f.size, rate: 0 });
        }
        continue;
      }
      if (f.size !== t.size || f.mtimeMs !== t.mtimeMs) {
        const dt = (now - t.sampleAt) / 1000;
        if (dt > 0) t.rate = Math.max(0, Math.round((f.size - t.sampleSize) / dt));
        Object.assign(t, { size: f.size, mtimeMs: f.mtimeMs, changedAt: now, sampleAt: now, sampleSize: f.size });
      } else if (now - t.changedAt >= this.opts.settleMs && f.size > 0) {
        t.state = "landed";
        t.landedAt = now;
        t.rate = 0;
        landed.push([rel, t]);
      }
    }
    this.primed = true;

    landed.sort((a, b) => a[1].landedAt - b[1].landedAt || a[0].localeCompare(b[0]));
    for (const [rel, t] of landed) for (const l of this.listeners) l.onPhoto(this.photo(rel, t));

    const uploading = this.uploading();
    if (uploading.length || this.lastProgressSent) for (const l of this.listeners) l.onProgress(uploading);
    this.lastProgressSent = uploading.length > 0;
  }
}

// ---- previews ----

/**
 * Finds the largest JPEG embedded in a RAW (or HEIC) file by walking each candidate's marker structure
 * properly, so a small thumbnail nested inside a bigger preview doesn't end the search early.
 */
export function largestEmbeddedJpeg(buf: Buffer): Buffer | null {
  let best: Buffer | null = null;
  let from = 0;
  while (from < buf.length - 3) {
    const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), from);
    if (start < 0) break;
    const end = jpegEnd(buf, start);
    if (end > start) {
      if (!best || end - start > best.length) best = buf.subarray(start, end);
      from = end;
    } else {
      from = start + 3;
    }
  }
  return best && best.length > 4096 ? best : null;
}

/** Returns the offset just past the JPEG's EOI marker, or -1 when the structure doesn't hold together. */
function jpegEnd(buf: Buffer, start: number): number {
  let i = start + 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return -1;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) return i + 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return -1;
    i += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data: 0xFF is always stuffed (FF00) or a restart marker until the real next marker.
      while (i + 1 < buf.length) {
        if (buf[i] === 0xff) {
          const n = buf[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
    }
  }
  return -1;
}

export class PreviewError extends Error {}

const MAX_EDGE = 2560;
const inflight = new Map<string, Promise<string>>();

/** Makes (or reuses) a screen-sized JPEG for a photo, and returns its path in the cache. */
export function buildPreview(cacheDir: string, sourceFile: string, size: number, mtimeMs: number): Promise<string> {
  const key = crypto.createHash("sha1").update(`${sourceFile}|${size}|${Math.round(mtimeMs)}`).digest("hex");
  const out = path.join(cacheDir, "tether", `${key}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    let input: Buffer = await fs.promises.readFile(sourceFile);
    const ext = path.extname(sourceFile).toLowerCase();
    if (!DIRECT.has(ext)) {
      const jpeg = largestEmbeddedJpeg(input);
      if (!jpeg) throw new PreviewError("This file has no embedded preview to show.");
      input = jpeg;
    }
    try {
      const data = await sharp(input, { failOn: "none" }).rotate().resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: false }).toBuffer();
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, out);
    } catch (err) {
      throw new PreviewError(`The preview couldn't be made (${(err as Error).message}).`);
    }
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Deletes previews older than a day; they are cheap to rebuild. */
export function pruneTetherCache(cacheDir: string, maxAgeMs = 86_400_000) {
  const dir = path.join(cacheDir, "tether");
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
    }
  } catch {
    /* no cache yet */
  }
}
