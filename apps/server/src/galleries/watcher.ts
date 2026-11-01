import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Logger } from "@openportrait/jobs";
import { isIgnoredName } from "./files.js";
import type { GalleryIngest } from "./ingest.js";

/**
 * Watches the gallery share and rescans shortly after things change, plus a periodic rescan as a
 * backstop: inotify events can be missed on Unraid user shares (FUSE) and on SMB writes.
 */
export function startGalleryWatcher(opts: { dir: string; ingest: GalleryIngest; rescanMinutes: number; settleSeconds: number; logger: Logger }): () => Promise<void> {
  const { dir, ingest, logger } = opts;
  let debounce: NodeJS.Timeout | null = null;
  const run = (why: string) => {
    ingest.scan().then(
      (r) => {
        if (r.added || r.changed || r.missing) logger.info({ ...r, why }, "galleries rescanned");
      },
      (err) => logger.error({ err: String(err), why }, "gallery scan failed"),
    );
  };
  const soon = () => {
    if (debounce) clearTimeout(debounce);
    // Wait out the settle window so a burst of exports becomes one scan.
    debounce = setTimeout(() => run("change"), Math.max(2, opts.settleSeconds) * 1000);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dir, {
      ignoreInitial: true,
      depth: 8,
      ignored: (p) => p !== dir && path.basename(p) !== "" && isIgnoredName(path.basename(p)),
      awaitWriteFinish: false,
    });
    watcher.on("all", soon);
    watcher.on("error", (err) => logger.warn({ err: String(err) }, "gallery watcher error; the periodic rescan still runs"));
  } catch (err) {
    logger.warn({ err: String(err) }, "could not watch the gallery folder; relying on the periodic rescan");
  }

  run("startup");
  const interval = opts.rescanMinutes > 0 ? setInterval(() => run("interval"), opts.rescanMinutes * 60_000) : null;

  return async () => {
    if (debounce) clearTimeout(debounce);
    if (interval) clearInterval(interval);
    ingest.close();
    await watcher?.close();
  };
}
