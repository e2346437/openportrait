import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { requireUser } from "../auth.js";
import { isImageFile, resolveInside } from "../galleries/files.js";
import { parse } from "../validate.js";

const { gallery } = tables;

/** Largest chunk one request may carry. The browser sends 8 MB at a time; this leaves room for faster links. */
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const STALE_MS = 7 * 86_400_000;

interface Meta {
  galleryId: string;
  set: string;
  filename: string;
  size: number;
  lastModified: number;
}

const Start = z.object({
  galleryId: z.string().min(1),
  /** A set (subfolder of the gallery) to put the file in; empty for the gallery's top level. */
  set: z.string().trim().max(80).regex(/^[^/\\]*$/, "A set name can't contain slashes.").default(""),
  filename: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_FILE),
  lastModified: z.number().int().nonnegative().default(0),
});

/**
 * Resumable uploads for working away from the share (docs/GALLERIES.md section 3.3). The browser starts an
 * upload, sends chunks at an offset, and after any break asks where it stopped. The same file always maps
 * to the same upload, so picking it again after closing the tab continues instead of starting over.
 */
export async function uploadRoutes(app: FastifyInstance) {
  const { db, config, galleries } = app.ctx;
  const dir = path.join(config.galleriesDir, ".openportrait", "uploads");
  fs.mkdirSync(dir, { recursive: true });

  // Half-sent uploads nobody came back to are cleared after a week.
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > STALE_MS) fs.rmSync(f, { force: true });
    } catch {
      /* already gone */
    }
  }

  app.addContentTypeParser("application/offset+octet-stream", { parseAs: "buffer", bodyLimit: MAX_CHUNK }, (_req, body, done) => done(null, body));
  app.addHook("preHandler", requireUser);

  const part = (id: string) => path.join(dir, `${id}.part`);
  const metaFile = (id: string) => path.join(dir, `${id}.json`);
  const readMeta = (id: string): Meta | null => {
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaFile(id), "utf8")) as Meta;
    } catch {
      return null;
    }
  };
  const offsetOf = (id: string) => {
    try {
      return fs.statSync(part(id)).size;
    } catch {
      return 0;
    }
  };

  app.post("/", async (req, reply) => {
    const body = parse(Start, req.body, reply);
    if (!body) return;
    const g = db.select().from(gallery).where(eq(gallery.id, body.galleryId)).get();
    if (!g) return reply.code(404).send({ error: "not_found", message: "That gallery no longer exists." });
    const filename = path.basename(body.filename).replace(/[\u0000-\u001f]/g, "").trim();
    if (!filename || !isImageFile(filename)) {
      return reply.code(415).send({ error: "unsupported", message: `“${body.filename}” isn't a photo type OpenPortrait can show. Use JPEG, PNG, WebP, TIFF or HEIC.` });
    }
    if (body.set.startsWith(".") || body.set.startsWith("_")) return reply.code(400).send({ error: "invalid", field: "set", message: "A set name can't start with a dot or underscore." });
    const id = crypto.createHash("sha256").update(JSON.stringify([g.id, body.set, filename, body.size, body.lastModified])).digest("hex").slice(0, 32);
    const meta: Meta = { galleryId: g.id, set: body.set, filename, size: body.size, lastModified: body.lastModified };
    if (!fs.existsSync(metaFile(id))) {
      fs.writeFileSync(metaFile(id), JSON.stringify(meta));
      fs.writeFileSync(part(id), "");
    } else if (!fs.existsSync(part(id))) {
      fs.writeFileSync(part(id), "");
    }
    return { id, offset: offsetOf(id), size: body.size, filename };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const meta = readMeta(req.params.id);
    if (!meta) return reply.code(404).send({ error: "not_found", message: "This upload was cleared. Start it again." });
    return { offset: offsetOf(req.params.id), size: meta.size, filename: meta.filename };
  });

  app.patch<{ Params: { id: string } }>("/:id", { bodyLimit: MAX_CHUNK }, async (req, reply) => {
    const { id } = req.params;
    const meta = readMeta(id);
    if (!meta) return reply.code(404).send({ error: "not_found", message: "This upload was cleared. Start it again." });
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "invalid", message: "Send the chunk as application/offset+octet-stream." });
    const offset = offsetOf(id);
    if (Number(req.headers["upload-offset"]) !== offset) {
      return reply.code(409).send({ error: "offset", message: "The server is at a different position.", offset });
    }
    if (offset + req.body.length > meta.size) return reply.code(413).send({ error: "too_big", message: "That chunk goes past the end of the file." });
    fs.appendFileSync(part(id), req.body);
    const next = offset + req.body.length;
    if (next < meta.size) return { offset: next, done: false };

    const g = db.select().from(gallery).where(eq(gallery.id, meta.galleryId)).get();
    if (!g) {
      fs.rmSync(part(id), { force: true });
      fs.rmSync(metaFile(id), { force: true });
      return reply.code(404).send({ error: "not_found", message: "That gallery no longer exists." });
    }
    const target = resolveInside(config.galleriesDir, meta.set ? `${g.folderPath}/${meta.set}` : g.folderPath);
    fs.mkdirSync(target, { recursive: true });
    // An existing file with the same name is never overwritten: the new one gets a number.
    const ext = path.extname(meta.filename);
    const stem = path.basename(meta.filename, ext);
    let name = meta.filename;
    for (let n = 2; fs.existsSync(path.join(target, name)); n++) name = `${stem} (${n})${ext}`;
    fs.renameSync(part(id), path.join(target, name));
    fs.rmSync(metaFile(id), { force: true });
    if (meta.lastModified) {
      const t = new Date(Math.min(meta.lastModified, Date.now() - 1000));
      fs.utimesSync(path.join(target, name), t, t);
    }
    galleries.syncGallery(g.id).catch((err) => app.log.error({ err: String(err) }, "sync after upload failed"));
    return { offset: next, done: true, filename: name };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    if (/^[a-f0-9]{32}$/.test(req.params.id)) {
      fs.rmSync(part(req.params.id), { force: true });
      fs.rmSync(metaFile(req.params.id), { force: true });
    }
    return { ok: true };
  });
}
