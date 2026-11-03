import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable, type Readable } from "node:stream";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { inspectDatabase } from "@openportrait/db";
import { BACKUP_NAME, type BackupManifest, type BackupService } from "./backup.js";

/**
 * Restoring a backup.
 *
 * The database can't be swapped while the app has it open, so a restore is staged first (validated, checked, safety
 * copy taken) and applied at the next start, before the database opens. Photos are then copied back into the
 * galleries in the background. Nothing in the galleries is ever deleted or overwritten.
 */

/** Said to the owner as is. */
export class RestoreError extends Error {}

export const RESTORE_DIR = "restore-pending";
const PLAN = "plan.json";
const STAGED_DB = "openportrait.db";
const RESULT_FILE = "restore-result.json";
const MAX_MANIFEST_BYTES = 1_000_000;
const HEADROOM = 100_000_000;

export interface RestorePlan {
  /** What the owner chose: a backup's file name, or the name of the file they uploaded. */
  source: string;
  /** Absolute path of the archive (or legacy .db) this restore reads from. */
  archive: string;
  kind: "zip" | "db";
  createdAt: string | null;
  includesGalleries: boolean;
  includesOriginals: boolean;
  files: number;
  fileBytes: number;
  counts: { contacts: number; shoots: number; orders: number };
  stagedAt: string;
  /** SHA-256 of the staged database, checked again before it replaces the live one. */
  dbSha256: string;
  phase: "staged" | "confirmed" | "files";
  /** Copy the photos in the archive back into the galleries. */
  withFiles: boolean;
  safetyBackup: string | null;
}

export interface RestoreResult {
  at: string;
  ok: boolean;
  from: string;
  message: string;
  filesRestored: number;
  filesSkipped: number;
  filesFailed: number;
  safetyBackup: string | null;
  problems: string[];
}

export interface RestoreState {
  plan: RestorePlan | null;
  result: RestoreResult | null;
  /** Photos being copied back right now. */
  copying: { done: number; total: number } | null;
  /** An upload is being received and checked. */
  busy: boolean;
}

// ---------- zip reading ----------

type Entry = yauzl.Entry;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
      if (err || !zip) reject(new RestoreError("This file isn't a readable backup archive. It may be damaged or incomplete."));
      else resolve(zip);
    });
  });
}

function listEntries(zip: yauzl.ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const out: Entry[] = [];
    zip.on("entry", (e: Entry) => {
      out.push(e);
      zip.readEntry();
    });
    zip.on("end", () => resolve(out));
    zip.on("error", () => reject(new RestoreError("This backup archive is damaged and can't be read.")));
    zip.readEntry();
  });
}

function entryStream(zip: yauzl.ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(new RestoreError("This backup archive is damaged and can't be read."));
      else resolve(stream);
    });
  });
}

/** Passes bytes through while computing the CRC-32 the archive recorded, so a changed or truncated file is caught. */
function crcCheck(expected: number, what: string) {
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      cb(crc === expected ? null : new RestoreError(`${what} doesn't match what was backed up, so the archive was changed or damaged.`));
    },
  });
}

async function readSmall(zip: yauzl.ZipFile, entry: Entry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_MANIFEST_BYTES) throw new RestoreError("This backup archive isn't valid.");
  const chunks: Buffer[] = [];
  await pipeline(await entryStream(zip, entry), crcCheck(entry.crc32, "A file in this backup"), new Writable({ write: (c: Buffer, _e, cb) => (chunks.push(c), cb()) }));
  return Buffer.concat(chunks);
}

/**
 * A path inside `files/` is only accepted when it is plain, relative and can't climb out of the galleries folder.
 * Returns the path below `files/`, or null when it is unsafe.
 */
export function safeRelative(name: string): string | null {
  if (!name.startsWith("files/")) return null;
  const rel = name.slice("files/".length);
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split("/");
  // The app never writes dot-files or empty segments, so an archive containing them did not come from the app.
  if (parts.some((p) => p === "" || p.startsWith(".") || p.length > 255)) return null;
  return parts.join("/");
}

interface ArchiveContents {
  manifest: BackupManifest;
  db: Entry;
  files: Array<{ entry: Entry; rel: string }>;
}

async function readContents(zip: yauzl.ZipFile): Promise<ArchiveContents> {
  try {
    return await readContentsOpen(zip);
  } finally {
    zip.close();
  }
}

async function readContentsOpen(zip: yauzl.ZipFile): Promise<ArchiveContents> {
  const entries = await listEntries(zip);
  let db: Entry | null = null;
  let manifestEntry: Entry | null = null;
  const files: ArchiveContents["files"] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.fileName)) throw new RestoreError("This archive isn't a backup made by OpenPortrait (it lists the same file twice).");
    seen.add(e.fileName);
    if (e.isEncrypted()) throw new RestoreError("This archive is password protected, so OpenPortrait can't read it.");
    const dir = e.fileName.endsWith("/");
    if (e.fileName === "openportrait.db") db = e;
    else if (e.fileName === "manifest.json") manifestEntry = e;
    else if (dir && (e.fileName === "files/" || safeRelative(e.fileName.slice(0, -1)) !== null)) continue;
    else if (!dir && safeRelative(e.fileName) !== null) files.push({ entry: e, rel: safeRelative(e.fileName)! });
    else throw new RestoreError("This archive isn't a backup made by OpenPortrait: it holds files in places a backup never uses.");
  }
  if (!db || !manifestEntry) throw new RestoreError("This archive isn't an OpenPortrait backup: it has no database or no manifest.");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse((await readSmall(zip, manifestEntry)).toString("utf8")) as BackupManifest;
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError("This archive isn't a backup made by OpenPortrait: its manifest can't be read.");
  }
  if (manifest?.app !== "openportrait" || manifest.version !== 1) throw new RestoreError("This archive was not made by this version of OpenPortrait, so it can't be restored.");
  return { manifest, db, files };
}

/** Streams one archive entry to `dest` through a temporary file, checking its CRC; the file appears only when whole. */
async function extractTo(zip: yauzl.ZipFile, entry: Entry, dest: string): Promise<void> {
  const tmp = `${dest}.partial`;
  try {
    await pipeline(await entryStream(zip, entry), crcCheck(entry.crc32, "A file in this backup"), fs.createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function freeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

function sniff(file: string): "zip" | "db" | null {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    if (buf.subarray(0, 2).toString() === "PK") return "zip";
    if (buf.toString("latin1", 0, 15) === "SQLite format 3") return "db";
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- applying at start-up ----------

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

function writeResult(configDir: string, r: RestoreResult) {
  fs.writeFileSync(path.join(configDir, RESULT_FILE), JSON.stringify(r), { mode: 0o600 });
}

/**
 * Runs before the database opens. When the owner has confirmed a restore, swaps the staged database in. Any problem
 * leaves the current database exactly as it was and is reported on the Backups page. Returns true when photos still
 * need copying back (done afterwards, in the background, by `RestoreService.copyFiles`).
 */
export function applyPendingRestore(configDir: string): boolean {
  const dir = path.join(configDir, RESTORE_DIR);
  const plan = readJson<RestorePlan>(path.join(dir, PLAN));
  if (!plan) return false;
  if (plan.phase === "files") return true;
  if (plan.phase !== "confirmed") return false;

  const fail = (message: string) => {
    writeResult(configDir, { at: new Date().toISOString(), ok: false, from: plan.source, message, filesRestored: 0, filesSkipped: 0, filesFailed: 0, safetyBackup: plan.safetyBackup, problems: [] });
    fs.rmSync(dir, { recursive: true, force: true });
    return false;
  };

  const staged = path.join(dir, STAGED_DB);
  if (!fs.existsSync(staged)) return fail("The restore was cancelled because the prepared database was missing. Nothing was changed.");
  const check = inspectDatabase(staged);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(staged)).digest("hex");
  if (!check.ok || hash !== plan.dbSha256) return fail("The restore was cancelled because the prepared database changed after it was checked. Nothing was changed.");
  if (plan.withFiles && plan.kind === "zip" && !fs.existsSync(plan.archive)) return fail("The restore was cancelled because the backup file is gone. Nothing was changed.");

  const live = path.join(configDir, "openportrait.db");
  const aside = path.join(configDir, "openportrait.db.before-restore");
  try {
    fs.rmSync(aside, { force: true });
    if (fs.existsSync(live)) fs.renameSync(live, aside);
    for (const ext of ["-wal", "-shm"]) fs.rmSync(`${live}${ext}`, { force: true });
    fs.renameSync(staged, live);
  } catch (err) {
    // Put the old database back if we got part way.
    if (!fs.existsSync(live) && fs.existsSync(aside)) fs.renameSync(aside, live);
    return fail(`The restore could not replace the database (${err instanceof Error ? err.message : "unknown error"}). Your current data was kept.`);
  }

  if (plan.withFiles && plan.kind === "zip" && plan.files > 0) {
    fs.writeFileSync(path.join(dir, PLAN), JSON.stringify({ ...plan, phase: "files" } satisfies RestorePlan), { mode: 0o600 });
    return true;
  }
  writeResult(configDir, { at: new Date().toISOString(), ok: true, from: plan.source, message: "Your studio data was restored.", filesRestored: 0, filesSkipped: 0, filesFailed: 0, safetyBackup: plan.safetyBackup, problems: [] });
  fs.rmSync(dir, { recursive: true, force: true });
  return false;
}

// ---------- service ----------

export class RestoreService {
  private busy = false;
  private copying: { done: number; total: number } | null = null;
  /** Resolves when background photo copying (if any) has finished. Tests await this. */
  filesDone: Promise<void> = Promise.resolve();
  /** Asks the process to stop so its supervisor starts it again. Replaced in tests. */
  restart: () => void = () => void setTimeout(() => process.kill(process.pid, "SIGTERM"), 400);

  constructor(
    private readonly deps: { configDir: string; galleriesDir: string; backups: BackupService; log: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void } },
  ) {}

  private get dir() {
    return path.join(this.deps.configDir, RESTORE_DIR);
  }

  private plan(): RestorePlan | null {
    return readJson<RestorePlan>(path.join(this.dir, PLAN));
  }

  state(): RestoreState {
    return { plan: this.plan(), result: readJson<RestoreResult>(path.join(this.deps.configDir, RESULT_FILE)), copying: this.copying, busy: this.busy };
  }

  /** Starts copying photos if the last start left a restore in its photo phase. */
  resume(): void {
    if (this.plan()?.phase === "files") this.filesDone = this.copyFiles().catch((err) => this.deps.log.warn({ err: String(err) }, "restore: copying photos failed"));
  }

  private clearStaging() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** The upload folder: made fresh, so two restores never mix files. */
  private freshDir() {
    this.clearStaging();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return this.dir;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy || this.plan()?.phase === "confirmed" || this.plan()?.phase === "files") throw new RestoreError("A restore is already in progress.");
    this.busy = true;
    return fn().finally(() => (this.busy = false));
  }

  /** Stage a restore from a backup in the Backups list. */
  stageBackup(name: string): Promise<RestorePlan> {
    return this.lock(async () => {
      const file = this.deps.backups.pathOf(name);
      if (!file || !BACKUP_NAME.test(name)) throw new RestoreError("That backup no longer exists.");
      const dir = this.freshDir();
      try {
        return await this.stage(dir, file, name);
      } catch (err) {
        this.clearStaging();
        throw err;
      }
    });
  }

  /** Stage a restore from an uploaded file, received as a stream so big archives never sit in memory. */
  stageUpload(body: Readable, declaredSize: number, filename: string): Promise<RestorePlan> {
    return this.lock(async () => {
      if (declaredSize > 0 && freeBytes(this.deps.configDir) < declaredSize + HEADROOM) throw new RestoreError("There isn't enough free space to receive this file. Free some space in the config folder first.");
      const dir = this.freshDir();
      const part = path.join(dir, "upload.part");
      try {
        await pipeline(body, fs.createWriteStream(part, { mode: 0o600 }));
        if ((body as { truncated?: boolean }).truncated) throw new RestoreError("The upload was cut short. Try again.");
        const kind = fs.statSync(part).size < 16 ? null : sniff(part);
        if (!kind) throw new RestoreError("That file isn't an OpenPortrait backup. Choose a .zip backup (or an older .db copy) from the Backups page.");
        const kept = path.join(dir, kind === "zip" ? "upload.zip" : "upload.db");
        fs.renameSync(part, kept);
        return await this.stage(dir, kept, filename.replace(/[^\w .()-]/g, "_").slice(0, 120) || "uploaded backup");
      } catch (err) {
        this.clearStaging();
        throw err;
      }
    });
  }

  /** Checks an archive from front to back, extracts its database, and writes the plan. */
  private async stage(dir: string, archive: string, source: string): Promise<RestorePlan> {
    const kind = sniff(archive);
    if (!kind) throw new RestoreError("That file isn't an OpenPortrait backup.");
    const stagedDb = path.join(dir, STAGED_DB);
    let manifest: BackupManifest | null = null;
    let files = 0;
    let fileBytes = 0;

    if (kind === "zip") {
      const zip = await openZip(archive);
      const contents = await readContents(zip);
      if (freeBytes(dir) < contents.db.uncompressedSize * 3 + HEADROOM) throw new RestoreError("There isn't enough free space to prepare this restore.");
      manifest = contents.manifest;
      files = contents.files.length;
      fileBytes = contents.files.reduce((n, f) => n + f.entry.uncompressedSize, 0);
      // The archive is closed once its list has been read, so open it again for the database.
      await extractDatabase(archive, stagedDb);
    } else {
      if (freeBytes(dir) < fs.statSync(archive).size * 2 + HEADROOM) throw new RestoreError("There isn't enough free space to prepare this restore.");
      fs.copyFileSync(archive, stagedDb);
      fs.chmodSync(stagedDb, 0o600);
    }

    const check = inspectDatabase(stagedDb);
    if (!check.ok) throw new RestoreError(check.problem ?? "The database in this backup can't be used.");
    if (check.latestMigration !== null && check.latestMigration > check.appLatestMigration) {
      throw new RestoreError("This backup was made by a newer version of OpenPortrait than the one running now. Update OpenPortrait first, then restore it.");
    }

    // Keep a listed backup alive even if the schedule prunes it before the restart.
    let kept = archive;
    if (!archive.startsWith(dir) && kind === "zip") {
      try {
        kept = path.join(dir, "source.zip");
        fs.linkSync(archive, kept);
      } catch {
        kept = archive;
      }
    }

    const plan: RestorePlan = {
      source,
      archive: kept,
      kind,
      createdAt: manifest?.createdAt ?? null,
      includesGalleries: manifest?.includesGalleries ?? false,
      includesOriginals: manifest?.includesOriginals ?? false,
      files,
      fileBytes,
      counts: check.counts,
      stagedAt: new Date().toISOString(),
      dbSha256: await sha256File(stagedDb),
      phase: "staged",
      withFiles: files > 0,
      safetyBackup: null,
    };
    fs.writeFileSync(path.join(dir, PLAN), JSON.stringify(plan), { mode: 0o600 });
    return plan;
  }

  /** Owner confirmed: take a safety backup of the current data, then queue the swap for the next start. */
  async confirm(opts: { withFiles: boolean }): Promise<RestorePlan> {
    const plan = this.plan();
    if (!plan || plan.phase !== "staged") throw new RestoreError("There is no restore waiting for confirmation.");
    let safety: string;
    try {
      safety = (await this.deps.backups.run("manual", { databaseOnly: true, localOnly: true })).name;
    } catch (err) {
      throw new RestoreError(`Your current data couldn't be saved first, so nothing was changed. ${err instanceof Error ? err.message : ""}`.trim());
    }
    const next: RestorePlan = { ...plan, phase: "confirmed", withFiles: opts.withFiles && plan.files > 0, safetyBackup: safety };
    fs.writeFileSync(path.join(this.dir, PLAN), JSON.stringify(next), { mode: 0o600 });
    return next;
  }

  /** Throw away a staged (not yet confirmed) restore. */
  cancel(): boolean {
    const plan = this.plan();
    if (!plan) return false;
    if (plan.phase !== "staged") throw new RestoreError("This restore has been confirmed and is about to be applied, so it can't be cancelled.");
    this.clearStaging();
    return true;
  }

  dismissResult(): void {
    fs.rmSync(path.join(this.deps.configDir, RESULT_FILE), { force: true });
  }

  /** Copies photos from the archive into the galleries. Never overwrites or deletes anything. */
  async copyFiles(): Promise<void> {
    const plan = this.plan();
    if (!plan || plan.phase !== "files") return;
    const root = path.resolve(this.deps.galleriesDir);
    const result: RestoreResult = { at: "", ok: true, from: plan.source, message: "", filesRestored: 0, filesSkipped: 0, filesFailed: 0, safetyBackup: plan.safetyBackup, problems: [] };
    const problem = (m: string) => {
      result.filesFailed += 1;
      if (result.problems.length < 5) result.problems.push(m);
    };
    try {
      fs.mkdirSync(root, { recursive: true });
      const zip = await openZip(plan.archive);
      const { files } = await readContents(zip);
      this.copying = { done: 0, total: files.length };
      const zip2 = await openZip(plan.archive);
      const wanted = new Map(files.map((f) => [f.entry.fileName, f.rel]));
      await new Promise<void>((resolve, reject) => {
        zip2.on("error", reject);
        zip2.on("end", () => resolve());
        zip2.on("entry", (e: Entry) => {
          const rel = wanted.get(e.fileName);
          if (rel === undefined) return zip2.readEntry();
          void this.copyOne(zip2, e, root, rel, result, problem).then(() => {
            this.copying = { done: this.copying!.done + 1, total: files.length };
            zip2.readEntry();
          }, reject);
        });
        zip2.readEntry();
      }).finally(() => zip2.close());
      result.message = result.filesFailed
        ? `Your studio data was restored. ${result.filesFailed} photo${result.filesFailed === 1 ? "" : "s"} could not be copied back.`
        : "Your studio data and photos were restored.";
      result.ok = result.filesFailed === 0;
    } catch (err) {
      result.ok = false;
      result.message = `Your studio data was restored, but copying photos back stopped early: ${err instanceof Error ? err.message : "unknown error"}`;
    } finally {
      this.copying = null;
    }
    result.at = new Date().toISOString();
    writeResult(this.deps.configDir, result);
    this.clearStaging();
  }

  private async copyOne(zip: yauzl.ZipFile, entry: Entry, root: string, rel: string, result: RestoreResult, problem: (m: string) => void): Promise<void> {
    try {
      const target = path.resolve(root, ...rel.split("/"));
      if (!target.startsWith(root + path.sep)) return problem(`${rel}: outside the galleries folder`);
      // Never follow a link out of the galleries folder: every folder on the way must be a real folder.
      let cur = root;
      for (const part of rel.split("/").slice(0, -1)) {
        cur = path.join(cur, part);
        const st = fs.lstatSync(cur, { throwIfNoEntry: false });
        if (!st) fs.mkdirSync(cur);
        else if (!st.isDirectory()) return problem(`${rel}: a link or file is in the way`);
      }
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        result.filesSkipped += 1;
        return;
      }
      await extractTo(zip, entry, target);
      result.filesRestored += 1;
    } catch (err) {
      problem(`${rel}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
}

/** Pulls `openportrait.db` out of an archive into `dest`. */
async function extractDatabase(archive: string, dest: string): Promise<void> {
  const zip = await openZip(archive);
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => reject(new RestoreError("This backup has no database.")));
    zip.on("entry", (e: Entry) => {
      if (e.fileName !== "openportrait.db") return zip.readEntry();
      extractTo(zip, e, dest).then(resolve, reject).finally(() => zip.close());
    });
    zip.readEntry();
  });
}
