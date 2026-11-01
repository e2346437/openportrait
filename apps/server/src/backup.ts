import fs from "node:fs";
import path from "node:path";
import { backupDatabase, type Db } from "@openportrait/db";
import { defineJob, enqueue } from "@openportrait/jobs";
import type { Settings } from "./settings.js";

const KEEP = 14;

export function backupsDir(configDir: string): string {
  return path.join(configDir, "backups");
}

export function registerBackupJob(configDir: string, settings: () => Settings) {
  const job = defineJob("system.backup", async (_payload: Record<string, never>, { db }) => {
    const dir = backupsDir(configDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await backupDatabase(db, path.join(dir, `openportrait-${stamp}.db`));
    const files = fs.readdirSync(dir).filter((f) => /^openportrait-.*\.db$/.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - KEEP))) fs.rmSync(path.join(dir, old));
    settings().set("backup.lastAt", Date.now());
  });

  /** Queues a backup if the last one is more than a day old. Called hourly. */
  return function scheduleIfDue(db: Db): void {
    const last = settings().get("backup.lastAt") ?? 0;
    if (Date.now() - last > 24 * 3_600_000) enqueue(db, job, {}, { dedupeKey: "system.backup" });
  };
}
