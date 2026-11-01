import fs from "node:fs";
import path from "node:path";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { derivativePath, renderVariant, VARIANTS, type Variant } from "../galleries/derivatives.js";
import { newId, resolveInside } from "../galleries/files.js";
import { designOf, downloadState, loadSetsAndPhotos, mediaUrl, photoJson } from "../galleries/present.js";
import { verifyPassword } from "../auth.js";
import { planZip, splitParts, streamZip, zipFilename, type Scope } from "../galleries/zip.js";
import { email, parse } from "../validate.js";

const { gallery, gallerySet, photo, favoriteList, favoriteSelection, favoriteItem, galleryView, galleryVisitor, downloadEvent } = tables;

export const CLIENT_COOKIE = "op_client";
const CLIENT_COOKIE_DAYS = 365;

type Gallery = typeof tables.gallery.$inferSelect;

/**
 * Public client gallery API: /api/g/:slug. Anyone with the private link can view; an email is
 * asked for only at the first favorite or download (docs/GALLERIES.md section 6.1).
 */
export async function clientGalleryRoutes(app: FastifyInstance) {
  const { db, secrets, settings } = app.ctx;

  /** The studio logo, if one was uploaded; the version in the URL lets browsers cache it. */
  const studioLogo = () => {
    const v = settings.get("studio.logoVersion");
    return v ? `/api/branding/logo?v=${v}` : null;
  };

  const clientEmail = (req: FastifyRequest): string | null => {
    const raw = req.cookies[CLIENT_COOKIE];
    if (!raw) return null;
    const [encoded, sig] = raw.split(".");
    if (!encoded || !sig) return null;
    const value = Buffer.from(encoded, "base64url").toString("utf8");
    return secrets.verify("client", value, sig) ? value : null;
  };

  /** The cookie that remembers a visitor entered this gallery's password. It stops working when the password changes. */
  const passCookie = (g: Gallery) => `op_gp_${g.id}`;
  const passToken = (g: Gallery) => secrets.sign("gallery-password", `${g.id}:${g.passwordHash ?? ""}`);

  /** What a visitor still has to do before seeing photos. Staff previewing skip it. */
  const gateFor = (req: FastifyRequest, g: Gallery, who: string | null) => {
    if (req.user) return null;
    const password = g.accessMode === "password" && !!g.passwordHash && req.cookies[passCookie(g)] !== passToken(g);
    const register = g.registration !== "none" && !who ? g.registration : null;
    return password || register ? { password, register } : null;
  };

  /** Finds a gallery a visitor may see: live and not expired, or any gallery for signed-in staff (preview). */
  const load = (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply): Gallery | null => {
    const g = db.select().from(gallery).where(eq(gallery.slug, req.params.slug.toLowerCase())).get();
    if (!g || (g.status !== "live" && !req.user)) {
      void reply.code(404).send({ error: "not_found", message: "This gallery isn't available. Check the link, or ask your photographer for a new one." });
      return null;
    }
    if (g.expiresAt && g.expiresAt.getTime() < Date.now() && !req.user) {
      void reply.code(410).send({ error: "expired", message: "This gallery has expired. Ask your photographer if you need it back." });
      return null;
    }
    return g;
  };

  const me = (g: Gallery, who: string | null) => {
    if (!who) return { email: null, selections: [] };
    const lists = db.select({ id: favoriteList.id }).from(favoriteList).where(eq(favoriteList.galleryId, g.id)).all();
    if (!lists.length) return { email: who, selections: [] };
    const sels = db
      .select()
      .from(favoriteSelection)
      .where(and(eq(favoriteSelection.clientEmail, who), inArray(favoriteSelection.listId, lists.map((l) => l.id))))
      .all();
    const items = sels.length ? db.select().from(favoriteItem).where(inArray(favoriteItem.selectionId, sels.map((s) => s.id))).all() : [];
    return {
      email: who,
      selections: sels.map((s) => {
        const mine = items.filter((i) => i.selectionId === s.id);
        return { listId: s.listId, submittedAt: s.submittedAt?.getTime() ?? null, photoIds: mine.map((i) => i.photoId), notes: Object.fromEntries(mine.filter((i) => i.note).map((i) => [i.photoId, i.note])) };
      }),
    };
  };

  app.get<{ Params: { slug: string } }>("/:slug", async (req, reply) => {
    const g = load(req, reply);
    if (!g) return;
    const who = clientEmail(req);
    const { sets, photos } = loadSetsAndPhotos(db, g.id);
    const visibleSets = sets.filter((s) => !s.hidden);
    const setIds = new Set(visibleSets.map((s) => s.id));
    const visible = photos.filter((p) => p.state === "ready" && !p.hidden && setIds.has(p.setId));
    const byId = new Map(visible.map((p) => [p.id, p]));
    const coverOf = (id: string | null, fallback?: (typeof visible)[number]) => {
      const p = (id && byId.get(id)) || fallback;
      return p ? { id: p.id, thumb: mediaUrl(secrets, p, "thumb"), preview: mediaUrl(secrets, p, "preview"), placeholder: p.placeholder, width: p.width, height: p.height } : null;
    };

    if (!req.user) {
      const ipHash = secrets.sign("view", app.ctx.ip(req));
      const recent = db
        .select({ id: galleryView.id })
        .from(galleryView)
        .where(and(eq(galleryView.galleryId, g.id), eq(galleryView.ipHash, ipHash), gt(galleryView.createdAt, new Date(Date.now() - 30 * 60_000))))
        .get();
      if (!recent) db.insert(galleryView).values({ galleryId: g.id, clientEmail: who, ipHash }).run();
    }

    const lists = db.select().from(favoriteList).where(eq(favoriteList.galleryId, g.id)).all();
    reply.header("Cache-Control", "private, no-store");
    const gate = gateFor(req, g, who);
    if (gate) {
      // Nothing about the photos is sent until the visitor gets through. A password hides even the cover.
      return {
        studio: { name: settings.get("studio.name") ?? "", email: settings.get("studio.email") ?? "", logo: studioLogo() },
        gate,
        gallery: { title: g.title, slug: g.slug, preview: false, design: designOf(g), cover: gate.password ? null : coverOf(g.coverPhotoId, visible[0]), coverFocalX: g.coverFocalX, coverFocalY: g.coverFocalY, welcomeMessage: null, date: null },
        sets: [],
        photos: [],
        lists: [],
        me: { email: null, selections: [] },
      };
    }
    return {
      studio: { name: settings.get("studio.name") ?? "", email: settings.get("studio.email") ?? "", logo: studioLogo() },
      gallery: {
        title: g.title,
        welcomeMessage: g.welcomeMessage,
        slug: g.slug,
        preview: g.status !== "live",
        design: designOf(g),
        cover: coverOf(g.coverPhotoId, visible[0]),
        coverFocalX: g.coverFocalX,
        coverFocalY: g.coverFocalY,
        downloadSize: g.downloadSize,
        downloadLock: g.downloadLock,
        unlocked: !!g.unlockedAt,
        date: visible.find((p) => p.takenAt)?.takenAt?.getTime() ?? g.publishedAt?.getTime() ?? null,
      },
      sets: visibleSets
        .map((s) => ({
          id: s.id,
          name: s.name,
          count: visible.filter((p) => p.setId === s.id).length,
          cover: coverOf(s.coverPhotoId, visible.find((p) => p.setId === s.id)),
          coverFocalX: s.coverFocalX,
          coverFocalY: s.coverFocalY,
          download: downloadState(g, s),
        }))
        .filter((s) => s.count > 0),
      photos: visible.map((p) => photoJson(secrets, p)),
      lists: lists.sort((a, b) => a.sort - b.sort).map((l) => ({ id: l.id, name: l.name, maxCount: l.maxCount })),
      me: me(g, who),
    };
  });

  app.post<{ Params: { slug: string } }>("/:slug/identify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const g = load(req, reply);
    if (!g) return;
    const body = parse(z.object({ email, name: z.string().trim().max(100).optional() }), req.body, reply);
    if (!body) return;
    if (g.registration === "email_name" && !body.name) return reply.code(400).send({ error: "invalid", field: "name", message: "Enter your name." });
    if (body.name || g.registration !== "none") {
      db.insert(galleryVisitor)
        .values({ galleryId: g.id, email: body.email, name: body.name || null })
        .onConflictDoUpdate({ target: [galleryVisitor.galleryId, galleryVisitor.email], set: body.name ? { name: body.name } : { email: body.email } })
        .run();
    }
    const value = `${Buffer.from(body.email).toString("base64url")}.${secrets.sign("client", body.email)}`;
    reply.setCookie(CLIENT_COOKIE, value, { path: "/", httpOnly: true, sameSite: "lax", secure: req.protocol === "https" || req.headers["x-forwarded-proto"] === "https", maxAge: CLIENT_COOKIE_DAYS * 86_400 });
    return { me: me(g, body.email) };
  });

  app.post<{ Params: { slug: string } }>("/:slug/unlock", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const g = load(req, reply);
    if (!g) return;
    const body = parse(z.object({ password: z.string().min(1).max(100) }), req.body, reply);
    if (!body) return;
    const ok = g.passwordHash ? await verifyPassword(g.passwordHash, body.password) : false;
    if (!ok) return reply.code(401).send({ error: "wrong_password", field: "password", message: "That password isn't right. Check it with your photographer." });
    reply.setCookie(passCookie(g), passToken(g), { path: "/", httpOnly: true, sameSite: "lax", secure: req.protocol === "https" || req.headers["x-forwarded-proto"] === "https", maxAge: 30 * 86_400 });
    return { ok: true };
  });

  app.post<{ Params: { slug: string } }>("/:slug/forget", async (_req, reply) => {
    reply.clearCookie(CLIENT_COOKIE, { path: "/" });
    return { me: { email: null, selections: [] } };
  });

  /** Shared checks for changing a favorites list; sends the error and returns null when not allowed. */
  const selectionFor = (req: FastifyRequest<{ Params: { slug: string; listId: string } }>, reply: FastifyReply) => {
    const g = load(req, reply);
    if (!g) return null;
    const who = clientEmail(req);
    if (!who) {
      void reply.code(401).send({ error: "identify", message: "Enter your email so your favorites are saved." });
      return null;
    }
    const list = db.select().from(favoriteList).where(and(eq(favoriteList.id, req.params.listId), eq(favoriteList.galleryId, g.id))).get();
    if (!list) {
      void reply.code(404).send({ error: "not_found", message: "That favorites list no longer exists." });
      return null;
    }
    let sel = db.select().from(favoriteSelection).where(and(eq(favoriteSelection.listId, list.id), eq(favoriteSelection.clientEmail, who))).get();
    if (!sel) {
      sel = db.insert(favoriteSelection).values({ id: newId(), listId: list.id, clientEmail: who }).returning().get();
    }
    if (sel.submittedAt) {
      void reply.code(409).send({ error: "submitted", message: `You already sent “${list.name}” to the studio. Ask them to reopen it if you want to change it.` });
      return null;
    }
    return { g, who, list, sel };
  };

  const photoInGallery = (galleryId: string, photoId: string) =>
    db.select({ id: photo.id }).from(photo).where(and(eq(photo.id, photoId), eq(photo.galleryId, galleryId), eq(photo.hidden, false), eq(photo.state, "ready"))).get();

  app.put<{ Params: { slug: string; listId: string; photoId: string } }>("/:slug/lists/:listId/photos/:photoId", async (req, reply) => {
    const ctx = selectionFor(req, reply);
    if (!ctx) return;
    const body = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {}, reply);
    if (!body) return;
    if (!photoInGallery(ctx.g.id, req.params.photoId)) return reply.code(404).send({ error: "not_found", message: "That photo is no longer in the gallery." });
    const exists = db.select().from(favoriteItem).where(and(eq(favoriteItem.selectionId, ctx.sel.id), eq(favoriteItem.photoId, req.params.photoId))).get();
    if (!exists) {
      const n = db.select({ id: favoriteItem.photoId }).from(favoriteItem).where(eq(favoriteItem.selectionId, ctx.sel.id)).all().length;
      if (ctx.list.maxCount && n >= ctx.list.maxCount) {
        return reply.code(409).send({ error: "full", message: `“${ctx.list.name}” holds up to ${ctx.list.maxCount} photos. Remove one to add another.` });
      }
      db.insert(favoriteItem).values({ selectionId: ctx.sel.id, photoId: req.params.photoId, note: body.note ?? "" }).run();
    } else if (body.note !== undefined) {
      db.update(favoriteItem).set({ note: body.note }).where(and(eq(favoriteItem.selectionId, ctx.sel.id), eq(favoriteItem.photoId, req.params.photoId))).run();
    }
    return { me: me(ctx.g, ctx.who) };
  });

  app.delete<{ Params: { slug: string; listId: string; photoId: string } }>("/:slug/lists/:listId/photos/:photoId", async (req, reply) => {
    const ctx = selectionFor(req, reply);
    if (!ctx) return;
    db.delete(favoriteItem).where(and(eq(favoriteItem.selectionId, ctx.sel.id), eq(favoriteItem.photoId, req.params.photoId))).run();
    return { me: me(ctx.g, ctx.who) };
  });

  app.post<{ Params: { slug: string; listId: string } }>("/:slug/lists/:listId/submit", async (req, reply) => {
    const ctx = selectionFor(req, reply);
    if (!ctx) return;
    const n = db.select({ id: favoriteItem.photoId }).from(favoriteItem).where(eq(favoriteItem.selectionId, ctx.sel.id)).all().length;
    if (n === 0) return reply.code(409).send({ error: "empty", message: "Add at least one photo before sending." });
    db.update(favoriteSelection).set({ submittedAt: new Date() }).where(eq(favoriteSelection.id, ctx.sel.id)).run();
    return { me: me(ctx.g, ctx.who) };
  });

  /** Zips the visitor can download right now, with sizes, so the page can show "3 parts, 4.2 GB" before they click. */
  app.get<{ Params: { slug: string } }>("/:slug/downloads", async (req, reply) => {
    const g = load(req, reply);
    if (!g) return;
    const who = clientEmail(req);
    if (gateFor(req, g, who)) return reply.code(401).send({ error: "gate", message: "Open the gallery first." });
    reply.header("Cache-Control", "private, no-store");
    const { sets } = loadSetsAndPhotos(db, g.id);
    const describe = (key: string, name: string, scope: Scope) => {
      const { entries } = planZip(db, g, scope);
      return entries.length ? { key, name, scope: scope.kind, setId: scope.kind === "set" ? scope.setId : undefined, listId: scope.kind === "favorites" ? scope.listId : undefined, count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0), parts: splitParts(entries).length } : null;
    };
    const lists = who ? db.select().from(favoriteList).where(eq(favoriteList.galleryId, g.id)).all() : [];
    const visibleSets = sets.filter((s) => !s.hidden);
    const downloads = [
      describe("gallery", "Everything", { kind: "gallery" }),
      ...(visibleSets.length > 1 ? visibleSets.map((s) => describe(`set:${s.id}`, s.name, { kind: "set", setId: s.id })) : []),
      ...lists.map((l) => describe(`favorites:${l.id}`, `Your favorites${lists.length > 1 ? `: ${l.name}` : ""}`, { kind: "favorites", listId: l.id, email: who! })),
    ].filter((d): d is NonNullable<typeof d> => !!d);
    return { downloads, size: g.downloadSize };
  });

  /** One zip part, streamed as it is built: nothing is stored, and a closed tab stops the work. */
  app.get<{ Params: { slug: string }; Querystring: { scope?: string; set?: string; list?: string; part?: string } }>("/:slug/zip", async (req, reply) => {
    const g = load(req, reply);
    if (!g) return;
    const who = clientEmail(req);
    if (gateFor(req, g, who)) return reply.code(401).send({ error: "gate", message: "Open the gallery first." });
    if (!who && !req.user) return reply.code(401).send({ error: "identify", message: "Enter your email to download." });
    const q = req.query;
    let scope: Scope;
    if (q.scope === "set" && q.set) scope = { kind: "set", setId: q.set };
    else if (q.scope === "favorites" && q.list) scope = { kind: "favorites", listId: q.list, email: who ?? "" };
    else if (q.scope === "gallery") scope = { kind: "gallery" };
    else return reply.code(400).send({ error: "invalid", message: "Choose what to download." });
    const { entries, label } = planZip(db, g, scope);
    if (!entries.length) {
      const off = g.downloadSize === "none";
      return reply.code(off ? 403 : 404).send({ error: off ? "off" : "empty", message: off ? "Downloads are turned off for this gallery." : "Nothing here can be downloaded right now. It may still be locked, or there are no photos." });
    }
    const parts = splitParts(entries);
    const part = Math.min(Math.max(Number(q.part) || 1, 1), parts.length);
    const chosen = parts[part - 1]!;
    db.insert(downloadEvent).values({ galleryId: g.id, photoId: null, scope: scope.kind === "gallery" ? "gallery" : scope.kind, variant: g.downloadSize === "web" ? "web" : "full", clientEmail: who, ip: app.ctx.ip(req) }).run();
    const name = zipFilename(label, part, parts.length);
    const archive = streamZip({ galleriesDir: app.ctx.config.galleriesDir, cacheDir: app.ctx.config.cacheDir, gallery: g, entries: chosen, onError: (err) => app.log.warn({ err: String(err) }, "zip entry failed") });
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) archive.abort();
    });
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Accel-Buffering", "no");
    return reply.send(archive);
  });

  /** One photo, as the original file or a 2048 px JPEG, depending on the gallery's download size. */
  app.get<{ Params: { slug: string; photoId: string } }>("/:slug/photos/:photoId/download", async (req, reply) => {
    const g = load(req, reply);
    if (!g) return;
    const who = clientEmail(req);
    if (gateFor(req, g, who)) return reply.code(401).send({ error: "gate", message: "Open the gallery first." });
    if (!who && !req.user) return reply.code(401).send({ error: "identify", message: "Enter your email to download." });
    const p = db.select().from(photo).where(and(eq(photo.id, req.params.photoId), eq(photo.galleryId, g.id), eq(photo.state, "ready"), eq(photo.hidden, false))).get();
    if (!p) return reply.code(404).send({ error: "not_found", message: "That photo is no longer in the gallery." });
    const set = db.select().from(gallerySet).where(eq(gallerySet.id, p.setId)).get() ?? null;
    const state = downloadState(g, set);
    if (!state.allowed) {
      return reply.code(403).send({ error: state.reason, message: state.reason === "off" ? "Downloads are turned off for this gallery." : "Downloads open once the gallery is paid for." });
    }
    let file: string;
    let name = p.filename;
    if (g.downloadSize === "web") {
      file = derivativePath(app.ctx.config.cacheDir, g.id, p.id, p.version, "web");
      if (!fs.existsSync(file)) await renderVariant(path.join(app.ctx.config.galleriesDir, p.relPath), file, "web");
      name = name.replace(/\.[^.]+$/, "") + ".jpg";
    } else {
      file = resolveInside(app.ctx.config.galleriesDir, p.relPath);
    }
    db.insert(downloadEvent).values({ galleryId: g.id, photoId: p.id, scope: "photo", variant: g.downloadSize === "web" ? "web" : "full", clientEmail: who, ip: app.ctx.ip(req) }).run();
    const stat = fs.statSync(file);
    reply.header("Content-Type", contentType(file));
    reply.header("Content-Length", stat.size);
    reply.header("Content-Disposition", `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(fs.createReadStream(file));
  });
}

/** Signed thumbnails and previews: /media/:photoId/:version/:variant?s=... */
export async function mediaRoutes(app: FastifyInstance) {
  const { db, secrets, config } = app.ctx;
  app.get<{ Params: { photoId: string; version: string; variant: string }; Querystring: { s?: string } }>("/media/:photoId/:version/:variant", async (req, reply) => {
    const { photoId, version, variant } = req.params;
    if (!(variant === "thumb" || variant === "preview") || !req.query.s || !secrets.verify("media", `${photoId}:${version}:${variant}`, req.query.s)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const p = db.select().from(photo).where(eq(photo.id, photoId)).get();
    if (!p || String(p.version) !== version) return reply.code(404).send({ error: "not_found" });
    const file = derivativePath(config.cacheDir, p.galleryId, p.id, p.version, variant as Variant);
    if (!fs.existsSync(file)) {
      // The cache was cleared (it is safe to delete): rebuild this one on demand.
      try {
        await renderVariant(path.join(config.galleriesDir, p.relPath), file, variant as Variant);
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
    }
    reply.header("Content-Type", VARIANTS[variant as Variant].format === "jpeg" ? "image/jpeg" : "image/webp");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(file));
  });
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp", ".avif": "image/avif", ".heic": "image/heic", ".heif": "image/heif" }[ext] ??
    "application/octet-stream"
  );
}
