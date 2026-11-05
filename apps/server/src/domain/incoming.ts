import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DomainError, type ServiceContext } from "./context.js";
import { incomingSubfolderHooks } from "../extension-hooks.js";
import { resolveInside, safeSegment } from "./folders.js";
import { folderSettings, getShoot, listShoots } from "./shoots.js";
import { scanPhotos } from "./tether.js";
import { ymdIn } from "./time.js";

/** A file still arriving over SFTP keeps changing; leave it alone until it has been quiet this long. */
const QUIET_MS = 8_000;

export interface IncomingFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** False while the camera is still sending it. */
  ready: boolean;
}

export interface IncomingGroup {
  /** The folder under /incoming, such as "Z9/2026-11-14". Empty for files directly in /incoming. */
  key: string;
  label: string;
  /** The day these were shot, as year-month-day in the studio's time zone. */
  date: string;
  files: IncomingFile[];
  bytes: number;
  /** Shoots on that day that have a folder to move into. */
  suggestions: Array<{ id: string; subject: string }>;
}

/** Camera files waiting in Incoming, grouped by the folder the camera put them in (one per camera and day). */
export function listIncoming(ctx: ServiceContext, now = Date.now()): { groups: IncomingGroup[]; total: number; dir: string } {
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const found = scanPhotos(ctx.config.incomingDir);
  const byFolder = new Map<string, IncomingFile[]>();
  for (const f of found) {
    const slash = f.rel.lastIndexOf("/");
    const key = slash === -1 ? "" : f.rel.slice(0, slash);
    const list = byFolder.get(key) ?? [];
    list.push({ path: f.rel, name: f.rel.slice(slash + 1), size: f.size, mtimeMs: f.mtimeMs, ready: now - f.mtimeMs >= QUIET_MS });
    byFolder.set(key, list);
  }
  const shoots = listShoots(ctx, { status: "active", when: "all", limit: 200, children: "show" }).items.filter((s) => s.folderPath);
  const groups = [...byFolder.entries()].map(([key, files]) => {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const named = key.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const date = named ?? ymdIn(Math.max(...files.map((f) => f.mtimeMs)), tz);
    return {
      key,
      label: key || "Loose files",
      date,
      files,
      bytes: files.reduce((n, f) => n + f.size, 0),
      suggestions: shoots.filter((s) => s.startsAt !== null && ymdIn(s.startsAt, tz) === date).map((s) => ({ id: s.id, subject: s.subject })),
    };
  });
  groups.sort((a, b) => b.date.localeCompare(a.date) || a.label.localeCompare(b.label));
  return { groups, total: found.length, dir: ctx.config.incomingDir };
}

const hashOf = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });

function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new DomainError("invalid", "Too many files with that name.");
}

export interface MoveResult {
  moved: number;
  skipped: Array<{ path: string; reason: string }>;
  folder: string;
}

/**
 * Moves camera files into a shoot's RAW folder. Each is copied, checked against the original by checksum,
 * and only then removed from Incoming, so a failed or interrupted move never loses a photo.
 */
export async function moveToShoot(ctx: ServiceContext, shootId: string, paths: string[]): Promise<MoveResult> {
  const shoot = getShoot(ctx, shootId);
  if (!shoot.folderPath) throw new DomainError("invalid", "This shoot doesn't have a folder yet. Open the shoot and create its folder first.", 409);
  const rel = `${shoot.folderPath}/${folderSettings(ctx).rawSubdir}`;
  const dest = resolveInside(ctx.config.galleriesDir, rel);
  fs.mkdirSync(dest, { recursive: true });
  const result: MoveResult = { moved: 0, skipped: [], folder: rel };
  const skip = (p: string, reason: string) => result.skipped.push({ path: p, reason });

  for (const p of [...new Set(paths)]) {
    let src: string;
    try {
      src = resolveInside(ctx.config.incomingDir, p);
    } catch {
      skip(p, "Not inside Incoming.");
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(src);
    } catch {
      skip(p, "Already moved or removed.");
      continue;
    }
    if (!st.isFile()) {
      skip(p, "Not a file.");
      continue;
    }
    if (Date.now() - st.mtimeMs < QUIET_MS) {
      skip(p, "Still arriving from the camera.");
      continue;
    }
    let into = dest;
    for (const hook of incomingSubfolderHooks) {
      const sub = safeSegment(String(hook({ shootId, path: p }) ?? ""));
      if (sub) {
        into = path.join(dest, sub);
        break;
      }
    }
    const target = path.join(into, freeName(into, path.basename(src)));
    try {
      fs.mkdirSync(into, { recursive: true });
      fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
      if ((await hashOf(src)) !== (await hashOf(target))) {
        fs.rmSync(target, { force: true });
        skip(p, "The copy didn't match the original, so nothing was removed.");
        continue;
      }
      fs.unlinkSync(src);
      result.moved++;
      // Tidy up the camera's now-empty day folder, but never Incoming itself.
      for (let d = path.dirname(src); d !== path.resolve(ctx.config.incomingDir) && d.startsWith(path.resolve(ctx.config.incomingDir)); d = path.dirname(d)) {
        if (fs.readdirSync(d).length) break;
        fs.rmdirSync(d);
      }
    } catch (err) {
      fs.rmSync(target, { force: true });
      skip(p, `Couldn't copy it: ${(err as Error).message}`);
    }
  }
  return result;
}
