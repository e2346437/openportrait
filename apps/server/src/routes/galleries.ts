import fs from "node:fs";
import path from "node:path";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { hashPassword, requireOwner, requireUser } from "../auth.js";
import { fillCovers } from "../galleries/derivatives.js";
import { newId, titleFromFolder } from "../galleries/files.js";
import { designOf, loadSetsAndPhotos, mediaUrl, photoJson } from "../galleries/present.js";
import { galleryRecipients, sendGalleryReady } from "../galleries/notify.js";
import { email as emailField, parse } from "../validate.js";

const { message, gallery, gallerySet, photo, ingestFolder, favoriteList, favoriteSelection, favoriteItem, galleryView, downloadEvent } = tables;

const lock = z.enum(["until_paid", "highlights_early", "none"]);
const focal = z.number().min(0).max(100);
const Design = z
  .object({
    layout: z.enum(["full", "split", "framed", "minimal"]),
    landing: z.enum(["cards", "photos", "set"]),
    startSetId: z.string().nullable(),
    nav: z.enum(["icons", "text", "both"]),
    filenames: z.boolean(),
    grid: z.enum(["justified", "masonry", "square"]),
    size: z.enum(["s", "m", "l"]),
    spacing: z.union([z.literal(0), z.literal(4), z.literal(8), z.literal(18)]),
    theme: z.enum(["light", "dark"]),
    font: z.enum(["serif", "sans"]),
  })
  .partial();

const GalleryPatch = z
  .object({
    title: z.string().trim().min(1, "Give the gallery a title.").max(120),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, "Use at least 3 characters.")
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes."),
    coverPhotoId: z.string().nullable(),
    coverFocalX: focal,
    coverFocalY: focal,
    design: Design,
    downloadSize: z.enum(["none", "web", "full"]),
    downloadLock: lock,
    expiresAt: z.number().int().positive().nullable(),
    registration: z.enum(["none", "email", "email_name"]),
    welcomeMessage: z.string().trim().max(1500).nullable(),
    /** "password" needs `password` too; "link" clears it. */
    accessMode: z.enum(["link", "password"]),
    password: z.string().min(4, "Use at least 4 characters.").max(100),
  })
  .partial();

const SetPatch = z
  .object({
    name: z.string().trim().min(1, "Give the set a name.").max(80),
    hidden: z.boolean(),
    earlyDownload: z.boolean(),
    coverPhotoId: z.string().nullable(),
    coverFocalX: focal,
    coverFocalY: focal,
  })
  .partial();

const ListBody = z.object({
  name: z.string().trim().min(1, "Name the list.").max(60),
  maxCount: z.number().int().min(1, "A limit must be at least 1.").max(10_000).nullable(),
});

const GallerySettings = z.object({
  deliveryFolder: z
    .string()
    .trim()
    .min(1, "Enter a folder name.")
    .max(60)
    .refine((s) => !/[\\/:*?"<>|]/.test(s) && !s.startsWith("."), "Use a plain folder name without slashes."),
  privateFolders: z.array(z.string().trim().min(1).max(60)).max(10),
  defaultDownloadLock: lock,
});

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found", message: "That gallery no longer exists." });

export async function galleryRoutes(app: FastifyInstance) {
  const { db, secrets, galleries } = app.ctx;
  app.addHook("preHandler", requireUser);

  const thumbOf = (photoId: string | null) => {
    if (!photoId) return null;
    const p = db.select().from(photo).where(eq(photo.id, photoId)).get();
    return p && p.state === "ready" ? { thumb: mediaUrl(secrets, p, "thumb"), preview: mediaUrl(secrets, p, "preview"), placeholder: p.placeholder } : null;
  };

  app.get("/", async () => {
    const rows = db.select().from(gallery).orderBy(desc(gallery.updatedAt)).all();
    const counts = new Map(
      db
        .select({ galleryId: photo.galleryId, total: count(), ready: sql<number>`sum(case when ${photo.state} = 'ready' then 1 else 0 end)`, pending: sql<number>`sum(case when ${photo.state} = 'pending' then 1 else 0 end)` })
        .from(photo)
        .where(sql`${photo.state} != 'missing'`)
        .groupBy(photo.galleryId)
        .all()
        .map((r) => [r.galleryId, r]),
    );
    const favs = new Map(
      db
        .select({ galleryId: favoriteList.galleryId, n: count() })
        .from(favoriteSelection)
        .innerJoin(favoriteList, eq(favoriteSelection.listId, favoriteList.id))
        .where(isNotNull(favoriteSelection.submittedAt))
        .groupBy(favoriteList.galleryId)
        .all()
        .map((r) => [r.galleryId, r.n]),
    );
    const unmatched = db.select({ n: count() }).from(ingestFolder).where(eq(ingestFolder.state, "unmatched")).get()?.n ?? 0;
    return {
      unmatched,
      galleries: rows.map((g) => ({
        id: g.id,
        title: g.title,
        slug: g.slug,
        status: g.status,
        shootFolder: g.shootFolder,
        sourceMissing: g.sourceMissing,
        photoCount: counts.get(g.id)?.total ?? 0,
        processing: counts.get(g.id)?.pending ?? 0,
        submittedFavorites: favs.get(g.id) ?? 0,
        cover: thumbOf(g.coverPhotoId),
        coverFocalX: g.coverFocalX,
        coverFocalY: g.coverFocalY,
        publishedAt: g.publishedAt?.getTime() ?? null,
        updatedAt: g.updatedAt.getTime(),
      })),
    };
  });

  const detail = (id: string) => {
    const g = db.select().from(gallery).where(eq(gallery.id, id)).get();
    if (!g) return null;
    const { sets, photos } = loadSetsAndPhotos(db, id);
    const lists = db.select().from(favoriteList).where(eq(favoriteList.galleryId, id)).orderBy(asc(favoriteList.sort)).all();
    const views = db.select({ n: count() }).from(galleryView).where(eq(galleryView.galleryId, id)).get()?.n ?? 0;
    const downloads = db.select({ n: count() }).from(downloadEvent).where(eq(downloadEvent.galleryId, id)).get()?.n ?? 0;
    return {
      gallery: {
        id: g.id,
        title: g.title,
        slug: g.slug,
        status: g.status,
        shootFolder: g.shootFolder,
        folderPath: g.folderPath,
        sourceMissing: g.sourceMissing,
        coverPhotoId: g.coverPhotoId,
        coverFocalX: g.coverFocalX,
        coverFocalY: g.coverFocalY,
        design: designOf(g),
        downloadSize: g.downloadSize,
        downloadLock: g.downloadLock,
        accessMode: g.accessMode,
        hasPassword: !!g.passwordHash,
        registration: g.registration,
        welcomeMessage: g.welcomeMessage,
        unlockedAt: g.unlockedAt?.getTime() ?? null,
        expiresAt: g.expiresAt?.getTime() ?? null,
        publishedAt: g.publishedAt?.getTime() ?? null,
        url: `${app.ctx.publicUrl()}/g/${g.slug}`,
        views,
        downloads,
      },
      sets: sets.map((s) => ({ id: s.id, name: s.name, folderName: s.folderName, hidden: s.hidden, earlyDownload: s.earlyDownload, coverPhotoId: s.coverPhotoId, coverFocalX: s.coverFocalX, coverFocalY: s.coverFocalY, sort: s.sort })),
      photos: photos.map((p) => ({ ...photoJson(secrets, p), state: p.state, error: p.error, hidden: p.hidden, relPath: p.relPath })),
      lists: lists.map((l) => ({ id: l.id, name: l.name, maxCount: l.maxCount })),
      recipients: galleryRecipients(app.ctx, g),
      emailReady: app.ctx.mailer.configured(),
      emails: db
        .select({ id: message.id, kind: message.kind, toEmail: message.toEmail, subject: message.subject, status: message.status, error: message.error, at: message.createdAt })
        .from(message)
        .where(eq(message.galleryId, g.id))
        .orderBy(desc(message.createdAt))
        .limit(30)
        .all()
        .map((m) => ({ ...m, at: m.at.getTime() })),
    };
  };

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => detail(req.params.id) ?? notFound(reply));

  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const body = parse(GalleryPatch, req.body, reply);
    if (!body) return;
    const g = db.select().from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    if (body.slug && body.slug !== g.slug && db.select({ id: gallery.id }).from(gallery).where(eq(gallery.slug, body.slug)).get()) {
      return reply.code(409).send({ error: "invalid", field: "slug", message: "Another gallery already uses that link." });
    }
    if (body.coverPhotoId && !db.select({ id: photo.id }).from(photo).where(and(eq(photo.id, body.coverPhotoId), eq(photo.galleryId, g.id))).get()) {
      return reply.code(400).send({ error: "invalid", field: "coverPhotoId", message: "That photo is not in this gallery." });
    }
    const { design, expiresAt, password, accessMode, ...rest } = body;
    const access: { accessMode?: "link" | "password"; passwordHash?: string | null } = {};
    if (accessMode === "link") Object.assign(access, { accessMode: "link", passwordHash: null });
    if (accessMode === "password" || password) {
      if (!password && !g.passwordHash) return reply.code(400).send({ error: "invalid", field: "password", message: "Choose a password for this gallery." });
      Object.assign(access, { accessMode: "password", ...(password ? { passwordHash: await hashPassword(password) } : {}) });
    }
    db.update(gallery)
      .set({
        ...rest,
        ...access,
        ...(design ? { design: { ...(g.design ?? {}), ...design } } : {}),
        ...(expiresAt !== undefined ? { expiresAt: expiresAt === null ? null : new Date(expiresAt) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(gallery.id, g.id))
      .run();
    return detail(g.id);
  });

  app.post<{ Params: { id: string } }>("/:id/publish", async (req, reply) => {
    const body = parse(z.object({ downloadLock: lock }), req.body ?? {}, reply);
    if (!body) return;
    const g = db.select().from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    const ready = db.select({ n: count() }).from(photo).where(and(eq(photo.galleryId, g.id), eq(photo.state, "ready"), eq(photo.hidden, false))).get()?.n ?? 0;
    if (ready === 0) return reply.code(409).send({ error: "empty", message: "There are no visible photos to share yet." });
    db.update(gallery).set({ status: "live", downloadLock: body.downloadLock, publishedAt: g.publishedAt ?? new Date(), updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
    return detail(g.id);
  });

  app.post<{ Params: { id: string } }>("/:id/email", async (req, reply) => {
    const body = parse(z.object({ to: z.array(z.object({ email: emailField, name: z.string().trim().max(120).optional(), contactId: z.string().nullish() })).min(1, "Choose who to email.").max(10), message: z.string().trim().max(2000).default("") }), req.body, reply);
    if (!body) return;
    const g = db.select().from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    if (g.status !== "live") return reply.code(409).send({ error: "draft", message: "Share the gallery first, then email the link." });
    if (!app.ctx.mailer.configured()) return reply.code(409).send({ error: "no_email", message: "Email isn't set up yet. Add your SMTP details in Settings › Email." });
    if (!/^https?:\/\//.test(app.ctx.publicUrl())) {
      return reply.code(409).send({ error: "no_url", message: "Set your public address in Settings › Internet access first, so the link in the email works for your client." });
    }
    const known = galleryRecipients(app.ctx, g);
    const to = body.to.map((r) => {
      const match = known.find((k) => k.email.toLowerCase() === r.email.toLowerCase());
      return { contactId: match?.contactId ?? null, name: r.name || match?.name || "", email: r.email };
    });
    const results = await sendGalleryReady(app.ctx, g, to, body.message, req.user?.id ?? null);
    return { results, ...detail(g.id) };
  });

  app.post<{ Params: { id: string } }>("/:id/unpublish", async (req, reply) => {
    const g = db.select({ id: gallery.id }).from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    db.update(gallery).set({ status: "draft", updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
    return detail(g.id);
  });

  /** Marks the gallery paid by hand (until PayPal lands, and for cash or check payments). */
  app.post<{ Params: { id: string } }>("/:id/unlock", async (req, reply) => {
    const body = (req.body ?? {}) as { locked?: boolean };
    const g = db.select({ id: gallery.id }).from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    db.update(gallery).set({ unlockedAt: body.locked ? null : new Date(), updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
    return detail(g.id);
  });

  app.post<{ Params: { id: string } }>("/:id/rescan", async (req, reply) => {
    const g = db.select({ id: gallery.id }).from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    const result = await galleries.syncGallery(g.id);
    return { result, ...detail(g.id) };
  });

  /** Removes the gallery from the app. Photos on the share are never touched; the folder returns to the inbox. */
  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireOwner }, async (req, reply) => {
    const g = db.select({ id: gallery.id }).from(gallery).where(eq(gallery.id, req.params.id)).get();
    if (!g) return notFound(reply);
    db.delete(gallery).where(eq(gallery.id, g.id)).run();
    fs.rmSync(path.join(app.ctx.config.cacheDir, "galleries", g.id), { recursive: true, force: true });
    void galleries.scan();
    return { ok: true };
  });

  app.patch<{ Params: { id: string; setId: string } }>("/:id/sets/:setId", async (req, reply) => {
    const body = parse(SetPatch, req.body, reply);
    if (!body) return;
    const s = db.select().from(gallerySet).where(and(eq(gallerySet.id, req.params.setId), eq(gallerySet.galleryId, req.params.id))).get();
    if (!s) return notFound(reply);
    if (body.coverPhotoId && !db.select({ id: photo.id }).from(photo).where(and(eq(photo.id, body.coverPhotoId), eq(photo.galleryId, s.galleryId))).get()) {
      return reply.code(400).send({ error: "invalid", field: "coverPhotoId", message: "That photo is not in this gallery." });
    }
    db.update(gallerySet).set(body).where(eq(gallerySet.id, s.id)).run();
    db.update(gallery).set({ updatedAt: new Date() }).where(eq(gallery.id, s.galleryId)).run();
    return detail(s.galleryId);
  });

  app.put<{ Params: { id: string } }>("/:id/sets/order", async (req, reply) => {
    const body = parse(z.object({ ids: z.array(z.string()).max(500) }), req.body, reply);
    if (!body) return;
    db.transaction((tx) => body.ids.forEach((id, i) => tx.update(gallerySet).set({ sort: i }).where(and(eq(gallerySet.id, id), eq(gallerySet.galleryId, req.params.id))).run()));
    return detail(req.params.id) ?? notFound(reply);
  });

  app.patch<{ Params: { id: string } }>("/:id/photos", async (req, reply) => {
    const body = parse(z.object({ ids: z.array(z.string()).min(1).max(5000), hidden: z.boolean() }), req.body, reply);
    if (!body) return;
    db.update(photo)
      .set({ hidden: body.hidden, updatedAt: new Date() })
      .where(and(eq(photo.galleryId, req.params.id), inArray(photo.id, body.ids)))
      .run();
    fillCovers(db, req.params.id);
    return detail(req.params.id) ?? notFound(reply);
  });

  // Favorites lists and what clients picked.
  app.post<{ Params: { id: string } }>("/:id/lists", async (req, reply) => {
    const body = parse(ListBody, req.body, reply);
    if (!body) return;
    if (!db.select({ id: gallery.id }).from(gallery).where(eq(gallery.id, req.params.id)).get()) return notFound(reply);
    const sort = (db.select({ n: count() }).from(favoriteList).where(eq(favoriteList.galleryId, req.params.id)).get()?.n ?? 0);
    db.insert(favoriteList).values({ id: newId(), galleryId: req.params.id, name: body.name, maxCount: body.maxCount, sort }).run();
    return detail(req.params.id);
  });

  app.patch<{ Params: { id: string; listId: string } }>("/:id/lists/:listId", async (req, reply) => {
    const body = parse(ListBody.partial(), req.body, reply);
    if (!body) return;
    db.update(favoriteList).set(body).where(and(eq(favoriteList.id, req.params.listId), eq(favoriteList.galleryId, req.params.id))).run();
    return detail(req.params.id) ?? notFound(reply);
  });

  app.delete<{ Params: { id: string; listId: string } }>("/:id/lists/:listId", async (req, reply) => {
    const lists = db.select({ id: favoriteList.id }).from(favoriteList).where(eq(favoriteList.galleryId, req.params.id)).all();
    if (lists.length <= 1) return reply.code(409).send({ error: "last_list", message: "A gallery keeps at least one favorites list." });
    db.delete(favoriteList).where(and(eq(favoriteList.id, req.params.listId), eq(favoriteList.galleryId, req.params.id))).run();
    return detail(req.params.id) ?? notFound(reply);
  });

  app.get<{ Params: { id: string } }>("/:id/favorites", async (req) => {
    const rows = db
      .select({ selection: favoriteSelection, listName: favoriteList.name, listId: favoriteList.id })
      .from(favoriteSelection)
      .innerJoin(favoriteList, eq(favoriteSelection.listId, favoriteList.id))
      .where(eq(favoriteList.galleryId, req.params.id))
      .orderBy(desc(favoriteSelection.createdAt))
      .all();
    const items = rows.length
      ? db
          .select({ selectionId: favoriteItem.selectionId, photoId: favoriteItem.photoId, note: favoriteItem.note, filename: photo.filename })
          .from(favoriteItem)
          .innerJoin(photo, eq(favoriteItem.photoId, photo.id))
          .where(inArray(favoriteItem.selectionId, rows.map((r) => r.selection.id)))
          .orderBy(asc(photo.filename))
          .all()
      : [];
    return {
      selections: rows.map((r) => ({
        id: r.selection.id,
        listId: r.listId,
        listName: r.listName,
        clientEmail: r.selection.clientEmail,
        submittedAt: r.selection.submittedAt?.getTime() ?? null,
        items: items.filter((i) => i.selectionId === r.selection.id).map(({ photoId, note, filename }) => ({ photoId, note, filename })),
      })),
    };
  });

  /** Lets a client change a selection they already sent. */
  app.post<{ Params: { id: string; selectionId: string } }>("/:id/favorites/:selectionId/reopen", async (req) => {
    db.update(favoriteSelection).set({ submittedAt: null }).where(eq(favoriteSelection.id, req.params.selectionId)).run();
    return { ok: true };
  });
}

/** Unmatched folders inbox: /api/studio/ingest. */
export async function ingestRoutes(app: FastifyInstance) {
  const { db, galleries, settings } = app.ctx;
  app.addHook("preHandler", requireUser);

  app.get<{ Querystring: { state?: string } }>("/folders", async (req) => {
    const state = req.query.state === "ignored" ? "ignored" : "unmatched";
    const rows = db.select().from(ingestFolder).where(eq(ingestFolder.state, state)).orderBy(desc(ingestFolder.lastChangeAt)).all();
    return {
      folders: rows.map((f) => ({
        id: f.id,
        relPath: f.relPath,
        suggestedTitle: titleFromFolder(f.relPath.split("/").pop() ?? f.relPath),
        fileCount: f.fileCount,
        sampleFiles: f.sampleFiles,
        stable: f.stable,
        firstSeenAt: f.firstSeenAt.getTime(),
        lastChangeAt: f.lastChangeAt.getTime(),
      })),
    };
  });

  app.post("/rescan", async () => ({ result: await galleries.scan() }));

  app.post<{ Params: { id: string } }>("/folders/:id/gallery", async (req, reply) => {
    const body = parse(z.object({ title: z.string().trim().max(120).optional() }), req.body ?? {}, reply);
    if (!body) return;
    const id = await galleries.createFromFolder(req.params.id, { title: body.title });
    if (!id) return reply.code(404).send({ error: "not_found", message: "That folder is no longer on the share." });
    return { galleryId: id };
  });

  app.post<{ Params: { id: string } }>("/folders/:id/ignore", async (req) => {
    const ignored = ((req.body ?? {}) as { ignored?: boolean }).ignored !== false;
    db.update(ingestFolder).set({ state: ignored ? "ignored" : "unmatched" }).where(eq(ingestFolder.id, req.params.id)).run();
    return { ok: true };
  });

  app.get("/settings", async () => ({
    deliveryFolder: settings.get("galleries.deliveryFolder") || "Gallery",
    privateFolders: settings.get("galleries.privateFolders") ?? ["Originals"],
    defaultDownloadLock: settings.get("galleries.defaultDownloadLock") ?? "none",
  }));

  app.put("/settings", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(GallerySettings, req.body, reply);
    if (!body) return;
    settings.set("galleries.deliveryFolder", body.deliveryFolder);
    settings.set("galleries.privateFolders", [...new Set(body.privateFolders.filter(Boolean))]);
    settings.set("galleries.defaultDownloadLock", body.defaultDownloadLock);
    void galleries.scan();
    return body;
  });
}
