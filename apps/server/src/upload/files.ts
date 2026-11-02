import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Turns whatever path a camera sends into a clean absolute path inside its own folder ("/" is the folder itself). */
export function cleanVirtual(p: string): string {
  const posix = p.replace(/\\/g, "/").replace(/\0/g, "");
  return path.posix.normalize("/" + posix).replace(/\/+$/, "") || "/";
}

/**
 * Maps a camera-visible path to a real path under `root`. Throws when the result would leave the folder,
 * including through a symbolic link someone placed on the share.
 */
export function jailPath(root: string, virtual: string): string {
  const base = path.resolve(root);
  const full = path.join(base, ...cleanVirtual(virtual).split("/").filter(Boolean));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("outside");
  // Resolve the nearest existing ancestor so a symlink can't point the write elsewhere.
  let probe = full;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const realBase = fs.realpathSync(base);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error("outside");
      break;
    } catch (err) {
      if ((err as Error).message === "outside") throw err;
      const parent = path.dirname(probe);
      if (parent === probe || probe === base) break;
      probe = parent;
    }
  }
  return full;
}

/** Smallest amount of free space a camera upload may start with; stops a stolen login from filling the disk (SEC-007). */
export const MIN_FREE_BYTES = Number(process.env.UPLOAD_MIN_FREE_MB ?? 512) * 1024 * 1024;

function freeBytes(dir: string): number | null {
  let probe = dir;
  for (;;) {
    try {
      const s = fs.statfsSync(probe);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/**
 * Moves a file without ever replacing one that is already there. A hard link fails atomically when the name is
 * taken, so two uploads can't race; directories (which can't be linked) get a check first.
 */
export function moveWithoutOverwrite(from: string, to: string, cb: (err?: NodeJS.ErrnoException | null) => void): void {
  fs.link(from, to, (err) => {
    if (!err) return fs.unlink(from, () => cb(null));
    if (err.code === "EEXIST") return cb(err);
    // Directories and other things that can't be hard-linked.
    fs.stat(from, (statErr, st) => {
      if (statErr || !st.isDirectory()) return cb(err);
      fs.access(to, (missing) => (missing ? fs.rename(from, to, cb) : cb(Object.assign(new Error("exists"), { code: "EEXIST" }))));
    });
  });
}

export interface LandOptions {
  /** File uploads sent to the folder's top level into a dated subfolder (YYYY-MM-DD). */
  sortByDay: boolean;
  /** Today's date in the studio's time zone. */
  today: string;
}

/** Where a finished upload belongs: files dropped at the top level go into a day folder when that option is on. */
export function landingVirtual(virtual: string, opts: LandOptions): string {
  const v = cleanVirtual(virtual);
  if (opts.sortByDay && path.posix.dirname(v) === "/") return `/${opts.today}${v}`;
  return v;
}

/**
 * One file being received. Bytes go to a hidden temporary name and the file is renamed into place only when the
 * camera finishes, so Lightroom, Aftershoot or the live view never pick up half a photo.
 */
export class IncomingFile {
  bytes = 0;
  /** Where the file really ended up; differs from finalPath when that name was already taken. */
  landedPath: string;
  private fd: number | null;
  private done = false;

  private constructor(
    fd: number,
    readonly tempPath: string,
    readonly finalPath: string,
    readonly name: string,
    private readonly append = false,
  ) {
    this.fd = fd;
    this.landedPath = finalPath;
  }

  static open(finalPath: string, opts: { append?: boolean } = {}): IncomingFile {
    const free = freeBytes(path.dirname(finalPath));
    if (free !== null && free < MIN_FREE_BYTES) throw new Error("The server is almost out of disk space, so it can't take more photos right now.");
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const tempPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${crypto.randomBytes(4).toString("hex")}.uploading`);
    if (opts.append && fs.existsSync(finalPath)) fs.copyFileSync(finalPath, tempPath);
    const fd = fs.openSync(tempPath, opts.append ? "a" : "w", 0o666);
    return new IncomingFile(fd, tempPath, finalPath, path.basename(finalPath), !!opts.append);
  }

  write(data: Buffer, position: number | null, cb: (err?: Error | null) => void): void {
    if (this.fd === null) return cb(new Error("closed"));
    fs.write(this.fd, data, 0, data.length, position, (err, n) => {
      if (!err) this.bytes += n;
      cb(err);
    });
  }

  /** Closes the file and moves it to its final name. */
  finish(cb: (err?: Error | null) => void): void {
    if (this.done || this.fd === null) return cb();
    this.done = true;
    const fd = this.fd;
    this.fd = null;
    fs.close(fd, (err) => {
      if (err) return cb(err);
      // Resuming a partial upload replaces its own earlier copy. Anything else never replaces a photo already in the
      // folder: a repeat of the name lands beside it as "name (2).ext" (SEC-007).
      if (this.append) return fs.rename(this.tempPath, this.finalPath, (renameErr) => cb(renameErr));
      const ext = path.extname(this.finalPath);
      const stem = this.finalPath.slice(0, this.finalPath.length - ext.length);
      const attempt = (n: number): void => {
        const target = n === 1 ? this.finalPath : `${stem} (${n})${ext}`;
        moveWithoutOverwrite(this.tempPath, target, (moveErr) => {
          if (moveErr?.code === "EEXIST" && n < 1000) return attempt(n + 1);
          if (!moveErr) this.landedPath = target;
          cb(moveErr);
        });
      };
      attempt(1);
    });
  }

  /** Drops a partial upload (the camera disconnected before it finished). */
  abort(): void {
    if (this.done) return;
    this.done = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    try {
      fs.unlinkSync(this.tempPath);
    } catch {
      /* already gone */
    }
  }
}

/** Removes leftover `.uploading` files older than a day, such as from a power cut. */
export function sweepStaleUploads(root: string, maxAgeMs = 86_400_000, now = Date.now()): number {
  let removed = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (e.name.startsWith(".") && e.name.endsWith(".uploading")) {
        try {
          if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root, 0);
  return removed;
}
