import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { backupDatabase, type Db } from "@openportrait/db";
import { defineJob, enqueue } from "@openportrait/jobs";
import { DestinationStore, providerFor } from "./backup-destinations.js";
import type { Settings } from "./settings.js";

export const BACKUP_DEFAULTS = { enabled: true, everyHours: 24, keep: 14, includeGalleries: false, includeOriginals: false } as const;
export const EVERY_HOURS_CHOICES = [6, 12, 24, 72, 168] as const;

export interface BackupConfig {
  enabled: boolean;
  everyHours: number;
  keep: number;
  includeGalleries: boolean;
  includeOriginals: boolean;
}

/** Written beside every archive (and inside it), so the list can say what a backup holds without opening it. */
export interface BackupManifest {
  app: "openportrait";
  version: 1;
  createdAt: string;
  trigger: "scheduled" | "manual";
  includesGalleries: boolean;
  includesOriginals: boolean;
  files: number;
  fileBytes: number;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: number;
  kind: "scheduled" | "manual" | "legacy";
  /** Legacy `.db` snapshots from older versions hold the database only. */
  includesGalleries: boolean;
  includesOriginals: boolean;
  files: number;
}

export function backupsDir(configDir: string): string {
  return path.join(configDir, "backups");
}

/** The only file names the app ever creates or serves. Anything else in the folder is left alone. */
export const BACKUP_NAME = /^openportrait-(?:manual-)?[0-9TZ-]+\.(?:zip|db)$/;

/** Counts and sizes of what a backup could include, so the owner can judge the cost before turning it on. */
export interface TreeSizes {
  galleries: { files: number; bytes: number };
  originals: { files: number; bytes: number };
}

function segmentMatches(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** Walks the galleries folder. A file is an "original" when it sits inside a private or RAW folder. */
export function* walkTree(root: string, privateNames: string[]): Generator<{ abs: string; rel: string; size: number; original: boolean }> {
  const stack: Array<{ dir: string; rel: string; original: boolean }> = [{ dir: root, rel: "", original: false }];
  while (stack.length) {
    const { dir, rel, original } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push({ dir: abs, rel: r, original: original || privateNames.some((p) => segmentMatches(p, e.name)) });
      else if (e.isFile()) {
        try {
          yield { abs, rel: r, size: fs.statSync(abs).size, original };
        } catch {
          /* vanished while walking */
        }
      }
    }
  }
}

export function measureTree(root: string, privateNames: string[]): TreeSizes {
  const out: TreeSizes = { galleries: { files: 0, bytes: 0 }, originals: { files: 0, bytes: 0 } };
  for (const f of walkTree(root, privateNames)) {
    const bucket = f.original ? out.originals : out.galleries;
    bucket.files += 1;
    bucket.bytes += f.size;
  }
  return out;
}

export class BackupService {
  private running = false;
  private lastError = "";
  readonly destinations: DestinationStore;

  constructor(
    private readonly deps: { db: Db; settings: Settings; configDir: string; galleriesDir: string },
  ) {
    this.destinations = new DestinationStore(deps.settings);
  }

  get dir() {
    return backupsDir(this.deps.configDir);
  }

  config(): BackupConfig {
    const s = this.deps.settings;
    return {
      enabled: s.get("backup.enabled") ?? BACKUP_DEFAULTS.enabled,
      everyHours: s.get("backup.everyHours") ?? BACKUP_DEFAULTS.everyHours,
      keep: s.get("backup.keep") ?? BACKUP_DEFAULTS.keep,
      includeGalleries: s.get("backup.includeGalleries") ?? BACKUP_DEFAULTS.includeGalleries,
      includeOriginals: s.get("backup.includeOriginals") ?? BACKUP_DEFAULTS.includeOriginals,
    };
  }

  saveConfig(c: BackupConfig): void {
    const s = this.deps.settings;
    s.set("backup.enabled", c.enabled);
    s.set("backup.everyHours", c.everyHours);
    s.set("backup.keep", c.keep);
    s.set("backup.includeGalleries", c.includeGalleries);
    s.set("backup.includeOriginals", c.includeOriginals);
  }

  status() {
    return { running: this.running, lastAt: this.deps.settings.get("backup.lastAt") ?? null, lastError: this.lastError || null };
  }

  private privateNames(): string[] {
    const s = this.deps.settings;
    return [...new Set([...(s.get("galleries.privateFolders") ?? ["Originals"]), s.get("folders.rawSubdir") ?? "Originals"])];
  }

  sizes(): TreeSizes {
    if (!fs.existsSync(this.deps.galleriesDir)) return { galleries: { files: 0, bytes: 0 }, originals: { files: 0, bytes: 0 } };
    return measureTree(this.deps.galleriesDir, this.privateNames());
  }

  list(): BackupFile[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: BackupFile[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!BACKUP_NAME.test(name)) continue;
      const st = fs.statSync(path.join(this.dir, name));
      let manifest: BackupManifest | null = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(this.dir, `${name}.json`), "utf8")) as BackupManifest;
      } catch {
        /* legacy snapshot or missing sidecar */
      }
      out.push({
        name,
        size: st.size,
        createdAt: manifest ? Date.parse(manifest.createdAt) || st.mtimeMs : st.mtimeMs,
        kind: !manifest ? "legacy" : manifest.trigger,
        includesGalleries: manifest?.includesGalleries ?? false,
        includesOriginals: manifest?.includesOriginals ?? false,
        files: manifest?.files ?? 0,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Absolute path of a backup, or null when the name isn't one the app made. */
  pathOf(name: string): string | null {
    if (!BACKUP_NAME.test(name)) return null;
    const p = path.join(this.dir, name);
    return fs.existsSync(p) ? p : null;
  }

  remove(name: string): boolean {
    const p = this.pathOf(name);
    if (!p) return false;
    fs.rmSync(p);
    fs.rmSync(`${p}.json`, { force: true });
    return true;
  }

  /**
   * Writes one backup archive: a consistent database snapshot plus, when chosen, the galleries and originals.
   * Throws a plain-language Error on a problem; the same text is shown to the owner.
   */
  async run(trigger: "scheduled" | "manual"): Promise<BackupFile> {
    if (this.running) throw new Error("A backup is already running.");
    this.running = true;
    try {
      const cfg = this.config();
      fs.mkdirSync(this.dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `openportrait-${trigger === "manual" ? "manual-" : ""}${stamp}.zip`;
      const final = path.join(this.dir, name);
      const tmp = path.join(this.dir, `.${name}.partial`);
      const snapshot = path.join(this.dir, `.${stamp}.db.partial`);

      const wantFiles = cfg.includeGalleries || cfg.includeOriginals;
      const picked = wantFiles && fs.existsSync(this.deps.galleriesDir) ? [...walkTree(this.deps.galleriesDir, this.privateNames())].filter((f) => (f.original ? cfg.includeOriginals : cfg.includeGalleries)) : [];
      const fileBytes = picked.reduce((n, f) => n + f.size, 0);

      // Check there is room before writing gigabytes: the snapshot plus the files, with a little headroom.
      const dbSize = fs.statSync(path.join(this.deps.configDir, "openportrait.db"), { throwIfNoEntry: false })?.size ?? 0;
      const need = dbSize * 2 + fileBytes + 50_000_000;
      const free = fs.statfsSync(this.dir);
      if (free.bavail * free.bsize < need) throw new Error("There isn't enough free space in the backups folder for this backup. Free some space or include fewer files.");

      try {
        await backupDatabase(this.deps.db, snapshot);
        const manifest: BackupManifest = {
          app: "openportrait",
          version: 1,
          createdAt: new Date().toISOString(),
          trigger,
          includesGalleries: cfg.includeGalleries,
          includesOriginals: cfg.includeOriginals,
          files: picked.length,
          fileBytes,
        };
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tmp, { mode: 0o600 });
          const zip = new ZipArchive({ store: true, forceZip64: true });
          out.on("close", resolve);
          out.on("error", reject);
          zip.on("error", reject);
          zip.pipe(out);
          zip.file(snapshot, { name: "openportrait.db" });
          zip.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
          // Everything is stored as is: photos do not shrink, and it keeps the server light.
          for (const f of picked) zip.file(f.abs, { name: `files/${f.rel}` });
          void zip.finalize();
        });
        fs.renameSync(tmp, final);
        fs.writeFileSync(`${final}.json`, JSON.stringify(manifest));
      } finally {
        fs.rmSync(snapshot, { force: true });
        fs.rmSync(tmp, { force: true });
      }

      if (trigger === "scheduled") this.prune(cfg.keep);
      this.deps.settings.set("backup.lastAt", Date.now());
      await this.copyOut(final, name, cfg.keep, trigger);
      this.lastError = "";
      return this.list().find((b) => b.name === name)!;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : "The backup failed.";
      throw err;
    } finally {
      this.running = false;
    }
  }

  /**
   * Copies a finished backup to every enabled destination. One destination failing never fails the backup or stops the
   * others; the error is saved on that destination and shown on the Backups page.
   */
  async copyOut(file: string, name: string, keep: number, trigger: "scheduled" | "manual"): Promise<void> {
    const size = fs.statSync(file).size;
    for (const d of this.destinations.all().filter((x) => x.enabled)) {
      const provider = providerFor(d.kind);
      try {
        if (!provider) throw new Error("The extension that provides this destination isn't loaded.");
        await provider.upload(d.config, { path: file, name, size });
        if (trigger === "scheduled") {
          const mine = (await provider.list(d.config)).map((f) => f.name).filter((n) => /^openportrait-[0-9TZ-]+\.(zip|db)$/.test(n)).sort().reverse();
          for (const old of mine.slice(Math.max(1, keep))) await provider.remove(d.config, old);
        }
        this.destinations.record(d.id, { ok: true, file: name });
      } catch (err) {
        this.destinations.record(d.id, { ok: false, error: err instanceof Error ? err.message : "The copy failed." });
      }
    }
  }

  /** Removes the oldest scheduled backups beyond `keep`. Manual backups and legacy snapshots are the owner's to delete. */
  private prune(keep: number) {
    const scheduled = this.list().filter((b) => b.kind === "scheduled");
    for (const old of scheduled.slice(Math.max(1, keep))) this.remove(old.name);
  }
}

export function registerBackupJob(service: BackupService, settings: () => Settings) {
  const job = defineJob("system.backup", async (_payload: Record<string, never>) => {
    // A failure is recorded for the Backups page and retried at the next hourly check, not retried in a tight loop.
    await service.run("scheduled").catch(() => undefined);
  });

  /** Queues a backup when one is due. Called hourly. */
  return function scheduleIfDue(db: Db): void {
    const cfg = service.config();
    if (!cfg.enabled) return;
    const last = settings().get("backup.lastAt") ?? 0;
    if (Date.now() - last > cfg.everyHours * 3_600_000) enqueue(db, job, {}, { dedupeKey: "system.backup" });
  };
}
