import { requestIsHttps } from "../client-ip.js";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { verifyPassword } from "../auth.js";
import { type MasterRow, resolveMaster } from "../domain/master.js";
import { serviceContext } from "./crm.js";
import { isWatermarked, loadSetsAndPhotos, previewUrl, watermarkInput } from "../galleries/present.js";
import { watermarkHash } from "../galleries/watermark.js";
import { parse } from "../validate.js";

const { shoot, gallery, masterAccess } = tables;
type Gallery = typeof gallery.$inferSelect;

/**
 * The organisation's page for a group day: /api/day/:token. Read-only, previews only, and only people whose
 * galleries are published and not marked off the page. It never reveals a person's own gallery link.
 */
export async function masterRoutes(app: FastifyInstance) {
  const { db, secrets, settings, config } = app.ctx;
  const ctx = (req: FastifyRequest) => serviceContext(app, req);

  const passCookie = (m: MasterRow) => `op_dm_${m.id}`;
  const passToken = (m: MasterRow) => secrets.sign("master-pass", `${m.id}:${m.version}:${m.passwordHash ?? ""}`);
  const cookieOpts = (req: FastifyRequest) => ({ path: "/", httpOnly: true, sameSite: "lax" as const, secure: requestIsHttps(req), maxAge: 30 * 86_400 });

  // Guessing links: a few misses per address per minute, then 429.
  const misses = new Map<string, { n: number; resetAt: number }>();
  const open = (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply): MasterRow | null => {
    const ip = app.ctx.ip(req);
    const now = Date.now();
    if (misses.size > 5000) for (const [k, v] of misses) if (v.resetAt < now) misses.delete(k);
    const m = misses.get(ip);
    if (m && m.resetAt > now && m.n >= 20) {
      void reply.code(429).header("retry-after", String(Math.ceil((m.resetAt - now) / 1000))).send({ error: "rate_limited", message: "Too many tries. Wait a minute and check the link." });
      return null;
    }
    const row = resolveMaster(ctx(req), secrets, req.params.token);
    if (!row) {
      if (!m || m.resetAt < now) misses.set(ip, { n: 1, resetAt: now + 60_000 });
      else m.n += 1;
      void reply.code(404).send({ error: "not_found", message: "This page isn't available. Check the link, or ask your photographer for a new one." });
      return null;
    }
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer").header("X-Robots-Tag", "noindex, nofollow");
    return row;
  };
  const locked = (req: FastifyRequest, m: MasterRow) => !!m.passwordHash && req.cookies[passCookie(m)] !== passToken(m);

  /** People on the day whose galleries a visitor may see: on the page, published, not expired. */
  const visible = (m: MasterRow) => {
    const kids = db.select({ id: shoot.id, subject: shoot.subject, folderPath: shoot.folderPath }).from(shoot).where(and(eq(shoot.parentId, m.parentId), eq(shoot.showOnMaster, true))).all();
    const folders = kids.map((k) => k.folderPath).filter((f): f is string => !!f);
    const galleries = folders.length ? db.select().from(gallery).where(and(eq(gallery.status, "live"), inArray(gallery.shootFolder, folders))).all() : [];
    return kids
      .map((k) => ({ kid: k, g: galleries.find((x) => x.shootFolder === k.folderPath) }))
      .filter((x): x is { kid: (typeof kids)[number]; g: Gallery } => !!x.g && !(x.g.expiresAt && x.g.expiresAt.getTime() < Date.now()))
      .sort((a, b) => a.kid.subject.localeCompare(b.kid.subject, undefined, { sensitivity: "base" }));
  };

  const studio = () => ({ name: settings.get("studio.name") ?? "", logo: settings.get("studio.logoVersion") ? `/api/branding/logo?v=${settings.get("studio.logoVersion")}` : null });
  const mark = () => watermarkHash(watermarkInput(settings, config.configDir));

  const readable = (g: Gallery) => {
    const { sets, photos } = loadSetsAndPhotos(db, g.id);
    const shown = new Set(sets.filter((s) => !s.hidden).map((s) => s.id));
    const m = mark();
    return photos
      .filter((p) => p.state === "ready" && !p.hidden && shown.has(p.setId))
      .map((p) => {
        const wm = isWatermarked(g, sets.find((s) => s.id === p.setId) ?? null) ? m : null;
        return { id: p.id, width: p.width, height: p.height, placeholder: p.placeholder, thumb: previewUrl(secrets, p, "thumb", wm), preview: previewUrl(secrets, p, "preview", wm) };
      });
  };

  app.get<{ Params: { token: string } }>("/:token", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const m = open(req, reply);
    if (!m) return;
    const day = db.select({ subject: shoot.subject, primaryContactId: shoot.primaryContactId }).from(shoot).where(eq(shoot.id, m.parentId)).get()!;
    if (locked(req, m)) return { studio: studio(), title: day.subject, locked: true, people: [] };
    db.update(masterAccess).set({ views: m.views + 1, lastViewedAt: new Date() }).where(eq(masterAccess.id, m.id)).run();
    return {
      studio: studio(),
      title: day.subject,
      locked: false,
      people: visible(m).map(({ kid, g }) => {
        const photos = readable(g);
        const cover = photos.find((p) => p.id === g.coverPhotoId) ?? photos[0] ?? null;
        return { id: kid.id, name: kid.subject, count: photos.length, cover: cover ? { thumb: cover.thumb, width: cover.width, height: cover.height, placeholder: cover.placeholder } : null };
      }),
    };
  });

  app.post<{ Params: { token: string } }>("/:token/unlock", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const m = open(req, reply);
    if (!m) return;
    const body = parse(z.object({ password: z.string().max(200) }), req.body ?? {}, reply);
    if (!body) return;
    if (!m.passwordHash || !(await verifyPassword(m.passwordHash, body.password))) return reply.code(401).send({ error: "password", message: "That password isn't right." });
    reply.setCookie(passCookie(m), passToken(m), cookieOpts(req));
    return { ok: true };
  });

  app.get<{ Params: { token: string; id: string } }>("/:token/people/:id", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const m = open(req, reply);
    if (!m) return;
    if (locked(req, m)) return reply.code(401).send({ error: "password", message: "Enter the password to see these photos." });
    const hit = visible(m).find((x) => x.kid.id === req.params.id);
    if (!hit) return reply.code(404).send({ error: "not_found", message: "This person isn't on the page." });
    return { id: hit.kid.id, name: hit.kid.subject, photos: readable(hit.g) };
  });

}

