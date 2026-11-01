import fs from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { lanAddresses } from "../app.js";
import { DomainError } from "../domain/context.js";
import { folderSettings, getShoot, listShoots } from "../domain/shoots.js";
import { resolveInside } from "../domain/folders.js";
import { buildPreview, FolderTracker, isPhotoFile, PreviewError, pruneTetherCache, type LandedPhoto, type UploadingFile } from "../domain/tether.js";
import { serviceContext } from "./crm.js";
import { parse } from "../validate.js";

interface Resolved {
  dir: string;
  label: string;
  skip: string[];
}

/**
 * SFTP Tethering: shows photos on a screen as soon as the camera's upload finishes.
 * The viewer subscribes to a server-sent event stream, so each photo is pushed the moment it lands.
 */
export async function tetherRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const { config } = app.ctx;
  const trackers = new Map<string, FolderTracker>();

  const resolve = (req: FastifyRequest, source: string): Resolved => {
    if (source === "incoming") return { dir: config.incomingDir, label: "Incoming", skip: [] };
    const ctx = serviceContext(app, req);
    const shoot = getShoot(ctx, source); // throws not_found
    if (!shoot.folderPath) throw new DomainError("invalid", "This shoot doesn't have a folder yet. Open the shoot and create its folder first.");
    return { dir: resolveInside(config.galleriesDir, shoot.folderPath), label: shoot.subject, skip: [folderSettings(ctx).deliverySubdir] };
  };

  const trackerFor = (key: string, r: Resolved) => {
    let t = trackers.get(key);
    if (!t) {
      t = new FolderTracker(r.dir, r.skip);
      trackers.set(key, t);
    }
    return t;
  };

  const prune = setInterval(() => pruneTetherCache(config.cacheDir), 3_600_000);
  prune.unref();
  app.addHook("onClose", async () => {
    clearInterval(prune);
    for (const t of trackers.values()) t.stop();
  });

  /** What the "which set?" picker offers. */
  app.get("/sources", async (req) => {
    const list = listShoots(serviceContext(app, req), { status: "active", when: "all", limit: 100 });
    return {
      incoming: { label: "Incoming", description: "Everything your camera uploads before it's sorted into a shoot." },
      shoots: list.items.filter((s) => s.folderPath).map((s) => ({ id: s.id, subject: s.subject, shootType: s.shootType, client: s.client, startsAt: s.startsAt })),
      lan: { addresses: lanAddresses(), port: config.port },
    };
  });

  /** Tiny and uncached, so the viewer can measure its round-trip time to the server. */
  app.get("/ping", { logLevel: "warn" }, async (_req, reply) => reply.header("Cache-Control", "no-store").send({ t: Date.now() }));

  app.get("/:source/events", async (req, reply) => {
    const source = (req.params as { source: string }).source;
    const r = resolve(req, source);
    const tracker = trackerFor(source, r);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write("retry: 2000\n\n");
    const snap = tracker.snapshot();
    send("hello", { label: r.label, folderReady: tracker.folderExists(), latest: snap.latest, total: snap.total, uploading: snap.uploading, now: Date.now() });

    const unsubscribe = tracker.subscribe({
      onPhoto: (p: LandedPhoto) => send("photo", { ...p, total: tracker.snapshot().total }),
      onProgress: (uploading: UploadingFile[]) => send("progress", { uploading }),
      onRemoved: (latest, total) => send("removed", { latest, total }),
    });
    // A comment line every 15 seconds keeps proxies from closing a quiet connection.
    // A live view open means cameras should be able to upload: keep an on-demand upload server open while it is.
    app.ctx.uploads.demand();
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(`: keep-alive\n\n`);
      app.ctx.uploads.demand();
    }, 15_000);
    const folderWatch = setInterval(() => send("folder", { folderReady: tracker.folderExists() }), 5_000);
    const done = () => {
      clearInterval(beat);
      clearInterval(folderWatch);
      unsubscribe();
    };
    req.raw.on("close", done);
  });

  /** The photos in this set so far, oldest first, for the back and forward buttons. */
  app.get("/:source/list", async (req) => {
    const source = (req.params as { source: string }).source;
    return { photos: trackerFor(source, resolve(req, source)).list() };
  });

  const PhotoQuery = z.object({ path: z.string().min(1).max(1000), v: z.string().optional() });
  app.get("/:source/photo", async (req, reply) => {
    const source = (req.params as { source: string }).source;
    const q = parse(PhotoQuery, req.query, reply);
    if (!q) return;
    const r = resolve(req, source);
    let file: string;
    try {
      file = resolveInside(r.dir, q.path);
    } catch {
      return reply.code(400).send({ error: "invalid", message: "That file isn't inside the watched folder." });
    }
    if (!isPhotoFile(file.split(/[\\/]/).pop() ?? "")) return reply.code(400).send({ error: "invalid", message: "That isn't a photo file." });
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return reply.code(404).send({ error: "not_found", message: "That photo is no longer there." });
    }
    try {
      const preview = await buildPreview(config.cacheDir, file, st.size, st.mtimeMs);
      return reply.header("Cache-Control", "private, max-age=3600").type("image/jpeg").send(fs.createReadStream(preview));
    } catch (err) {
      if (err instanceof PreviewError) return reply.code(422).send({ error: "no_preview", message: err.message });
      throw err;
    }
  });

  /** "I don't like that one": deletes the photo at once, for good, and tells every screen showing this folder. */
  app.delete("/:source/photo", async (req, reply) => {
    const source = (req.params as { source: string }).source;
    const q = parse(PhotoQuery, req.query, reply);
    if (!q) return;
    const r = resolve(req, source);
    let file: string;
    try {
      file = resolveInside(r.dir, q.path);
    } catch {
      return reply.code(400).send({ error: "invalid", message: "That file isn't inside the watched folder." });
    }
    if (!isPhotoFile(file.split(/[\\/]/).pop() ?? "") || !fs.existsSync(file)) return reply.code(404).send({ error: "not_found", message: "That photo is no longer there." });
    const rel = q.path.replace(/\\/g, "/");
    const t = trackerFor(source, r);
    const removed = t.remove(rel);
    if (!removed) return reply.code(500).send({ error: "failed", message: "Couldn't delete that photo." });
    return { ok: true, removed };
  });
}
