import fs from "node:fs";
import path from "node:path";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { ZipArchive } from "archiver";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { requireOwner } from "../auth.js";
import { mediaUrl } from "../galleries/present.js";
import { parse } from "../validate.js";
import { buildSite, loadSite, markExported, saveSite } from "../site/build.js";
import { cleanConfig, defaultSite } from "../site/config.js";
import { FONTS } from "../site/fonts.js";
import { siteExtensions, siteTemplates } from "../site/registry.js";
import type { SiteFile } from "../site/render.js";

const { gallery, photo, gallerySet, site } = tables;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".woff2": "font/woff2" };
const typeOf = (p: string) => TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";

const LookupBody = z.object({ ids: z.array(z.string().max(40)).max(400) });

/** The studio website builder (docs/website.md). Everything here is owner only. */
export async function siteRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db, secrets, settings } = ctx;
  app.addHook("preHandler", requireOwner);

  const payload = () => {
    const row = db.select().from(site).where(eq(site.id, "main")).get();
    return {
      config: loadSite(ctx),
      saved: !!row,
      lastExportedAt: row?.lastExportedAt?.getTime() ?? null,
      templates: siteTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description, header: t.header, gallery: t.gallery, theme: t.theme, extra: !!t.extra })),
      fonts: FONTS.map((f) => ({ id: f.id, label: f.label, kind: f.kind, stack: f.stack })),
      options: siteExtensions().filter((e) => e.options?.length).map((e) => ({ extension: e.id, title: e.title, fields: e.options })),
      hasLogo: fs.existsSync(path.join(ctx.config.configDir, "logo.png")),
      publicUrl: settings.get("internet.publicUrl") || ctx.publicUrl() || "",
    };
  };

  app.get("/", async () => payload());

  app.put("/", async (req, reply) => {
    if (!req.body || typeof req.body !== "object") return reply.code(400).send({ error: "invalid", message: "Send the site settings." });
    const config = cleanConfig(req.body, settings.get("studio.name") ?? "");
    saveSite(ctx, config);
    return payload();
  });

  app.post("/reset", async () => {
    saveSite(ctx, defaultSite(settings.get("studio.name") ?? ""));
    return payload();
  });

  /** Galleries to pick from. Draft galleries are listed too: the owner decides what goes public, not the gallery's status. */
  app.get("/library", async () => {
    const rows = db.select().from(gallery).orderBy(desc(gallery.updatedAt)).all();
    const counts = new Map(
      db
        .select({ galleryId: photo.galleryId, n: count() })
        .from(photo)
        .where(and(eq(photo.state, "ready"), eq(photo.hidden, false)))
        .groupBy(photo.galleryId)
        .all()
        .map((r) => [r.galleryId, r.n]),
    );
    return { galleries: rows.filter((g) => !g.sourceMissing).map((g) => ({ id: g.id, title: g.title, status: g.status, photoCount: counts.get(g.id) ?? 0 })).filter((g) => g.photoCount > 0) };
  });

  const thumb = (p: { id: string; version: number }) => mediaUrl(secrets, p, "thumb");

  app.get<{ Params: { id: string } }>("/library/:id", async (req, reply) => {
    const g = db.select().from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return reply.code(404).send({ error: "not_found", message: "That gallery doesn't exist." });
    const sets = new Map(db.select().from(gallerySet).where(eq(gallerySet.galleryId, g.id)).all().map((s) => [s.id, s]));
    const rows = db.select().from(photo).where(and(eq(photo.galleryId, g.id), eq(photo.state, "ready"), eq(photo.hidden, false))).orderBy(asc(photo.sort), asc(photo.filename)).all();
    return { title: g.title, photos: rows.filter((p) => !sets.get(p.setId)?.hidden).map((p) => ({ id: p.id, filename: p.filename, thumb: thumb(p), width: p.width, height: p.height, set: sets.get(p.setId)?.name ?? "" })) };
  });

  /** Thumbnails for photos already chosen, so the builder can show them. A photo that has gone comes back with `missing`. */
  app.post("/photos", async (req, reply) => {
    const body = parse(LookupBody, req.body, reply);
    if (!body) return;
    const found = new Map<string, typeof photo.$inferSelect>();
    for (const id of body.ids) {
      const p = db.select().from(photo).where(eq(photo.id, id)).get();
      if (p) found.set(id, p);
    }
    return { photos: body.ids.map((id) => (found.has(id) ? { id, thumb: thumb(found.get(id)!), filename: found.get(id)!.filename, width: found.get(id)!.width, height: found.get(id)!.height, missing: found.get(id)!.state === "missing" } : { id, missing: true })) };
  });

  /** What an export would contain and what to fix first. Builds the site, so it also warms the image cache. */
  app.get("/report", async () => {
    const built = await buildSite(ctx);
    const pages = built.files.filter((f) => f.path.endsWith("index.html")).length;
    const bytes = built.files.reduce((n, f) => n + ("file" in f ? fs.statSync(f.file).size : "bytes" in f ? f.bytes.length : Buffer.byteLength(f.text)), 0);
    return { warnings: built.warnings, pages, photos: built.photoCount, files: built.files.length, bytes, template: built.template.id };
  });

  const serve = async (rel: string, reply: import("fastify").FastifyReply) => {
    const built = await buildSite(ctx);
    const want = rel === "" || rel.endsWith("/") ? `${rel}index.html` : rel;
    const f: SiteFile | undefined = built.files.find((x) => x.path === want) ?? (rel && !rel.endsWith("/") ? built.files.find((x) => x.path === `${rel}/index.html`) : undefined);
    if (!f) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    reply.header("Cache-Control", "no-store");
    reply.type(typeOf(f.path));
    if ("text" in f) return reply.send(f.text);
    if ("bytes" in f) return reply.send(f.bytes);
    return reply.send(fs.createReadStream(f.file));
  };

  // The preview is the real export served from here, so what you see is what you upload.
  app.get("/preview", async (_req, reply) => reply.redirect("/api/studio/site/preview/"));
  app.get<{ Params: { "*": string } }>("/preview/*", async (req, reply) => serve(req.params["*"], reply));

  app.get("/export.zip", async (req, reply) => {
    const built = await buildSite(ctx);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", (err: Error) => app.log.warn({ err: String(err) }, "site export failed"));
    for (const f of built.files) {
      if ("text" in f) archive.append(f.text, { name: f.path });
      else if ("bytes" in f) archive.append(f.bytes, { name: f.path });
      else archive.file(f.file, { name: f.path, store: true } as never);
    }
    void archive.finalize();
    markExported(ctx);
    const slug = (built.config.name || "website").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "website";
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${slug}-website.zip"`);
    reply.header("Cache-Control", "no-store");
    return reply.send(archive);
  });
}
