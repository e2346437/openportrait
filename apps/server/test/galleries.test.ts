import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { discover, listGalleryFiles } from "../src/galleries/discover.js";
import { isImageFile, resolveInside, titleFromFolder } from "../src/galleries/files.js";

let app: FastifyInstance;
let root: string;
let share: string;
let staff: string;

async function jpeg(file: string, color: { r: number; g: number; b: number }, width = 300, height = 200) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(file);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
}

const red = { r: 200, g: 30, b: 30 };
const blue = { r: 30, g: 30, b: 200 };
const green = { r: 30, g: 160, b: 60 };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-gal-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), INGEST_SETTLE_SECONDS: "0" });
  share = config.galleriesDir;
  fs.mkdirSync(share, { recursive: true });
  app = await buildApp({ config, startBackground: false, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Test Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  staff = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const studio = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api/studio${url}`, payload, headers: { cookie: staff } });

/** Scans, turns the first inbox folder into a gallery, builds previews. */
async function galleryFromShare(): Promise<{ id: string; slug: string; detail: any }> {
  await studio("POST", "/ingest/rescan");
  const folders = (await studio("GET", "/ingest/folders")).json().folders;
  const created = (await studio("POST", `/ingest/folders/${folders[0].id}/gallery`, {})).json();
  await app.ctx.jobs.drain();
  const detail = (await studio("GET", `/galleries/${created.galleryId}`)).json();
  return { id: created.galleryId, slug: detail.gallery.slug, detail };
}

describe("folder discovery", () => {
  it("treats a folder with a Gallery subfolder as a shoot and never reads Originals", async () => {
    const shoot = path.join(share, "2026/2026-11-14 Family - Smith Family");
    await jpeg(path.join(shoot, "Gallery/Highlights/a.jpg"), red);
    await jpeg(path.join(shoot, "Gallery/Full Gallery/b.jpg"), blue);
    await jpeg(path.join(shoot, "Originals/RAW/raw-preview.jpg"), green);
    expect(discover(share)).toEqual([{ shootFolder: "2026/2026-11-14 Family - Smith Family", root: "2026/2026-11-14 Family - Smith Family/Gallery" }]);
    const sets = listGalleryFiles(share, "2026/2026-11-14 Family - Smith Family/Gallery");
    expect([...sets.keys()].sort()).toEqual(["Full Gallery", "Highlights"]);
  });

  it("groups image subfolders of a hand-made folder into one gallery, but not year folders", async () => {
    await jpeg(path.join(share, "Jones Wedding/Ceremony/1.jpg"), red);
    await jpeg(path.join(share, "Jones Wedding/Reception/2.jpg"), blue);
    await jpeg(path.join(share, "2025/Headshots Lee/1.jpg"), green);
    await jpeg(path.join(share, "2025/Headshots Kim/1.jpg"), green);
    await jpeg(path.join(share, ".openportrait/uploads/x.jpg"), green);
    expect(discover(share).map((c) => c.shootFolder)).toEqual(["2025/Headshots Kim", "2025/Headshots Lee", "Jones Wedding"]);
  });

  it("ignores partial and system files, and refuses paths outside the share", () => {
    expect(isImageFile("IMG_1.JPG")).toBe(true);
    expect(isImageFile("IMG_1.jpg.part")).toBe(false);
    expect(isImageFile("._IMG_1.jpg")).toBe(false);
    expect(isImageFile("IMG_1.NEF")).toBe(false);
    expect(() => resolveInside(share, "../etc/passwd")).toThrow();
    expect(titleFromFolder("2026-11-14 Family - Smith Family")).toBe("Smith Family");
    expect(titleFromFolder("Jones Wedding")).toBe("Jones Wedding");
  });
});

describe("ingest", () => {
  it("puts new folders in the inbox and imports them as a draft gallery with previews", async () => {
    await jpeg(path.join(share, "2026/2026-11-14 Family - Smith Family/Gallery/Highlights/a.jpg"), red, 400, 300);
    await jpeg(path.join(share, "2026/2026-11-14 Family - Smith Family/Gallery/b.jpg"), blue);
    await studio("POST", "/ingest/rescan");
    const { folders } = (await studio("GET", "/ingest/folders")).json();
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ relPath: "2026/2026-11-14 Family - Smith Family", suggestedTitle: "Smith Family", fileCount: 2 });

    const { id, detail } = await galleryFromShare();
    expect(detail.gallery).toMatchObject({ title: "Smith Family", status: "draft" });
    expect(detail.sets.map((s: { name: string }) => s.name)).toEqual(["Photos", "Highlights"]);
    const a = detail.photos.find((p: { filename: string }) => p.filename === "a.jpg");
    expect(a).toMatchObject({ state: "ready", width: 400, height: 300 });
    expect(a.placeholder).toMatch(/^data:image\/webp;base64,/);
    expect(detail.gallery.coverPhotoId).toBeTruthy();
    expect(detail.lists).toEqual([expect.objectContaining({ name: "Favorites" })]);

    const media = await app.inject(a.thumb);
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toBe("image/webp");
    expect(media.headers["cache-control"]).toContain("immutable");
    expect((await app.inject(a.thumb.replace(/s=.*/, "s=forged"))).statusCode).toBe(404);
    expect((await studio("GET", "/ingest/folders")).json().folders).toHaveLength(0);
    expect((await studio("GET", "/galleries")).json().galleries[0]).toMatchObject({ id, photoCount: 2, processing: 0 });
  });

  it("keeps a photo's identity across re-exports and renames, and marks deleted ones missing", async () => {
    const dir = path.join(share, "Lee Headshots");
    await jpeg(path.join(dir, "one.jpg"), red);
    await jpeg(path.join(dir, "two.jpg"), blue);
    const { id, detail } = await galleryFromShare();
    const one = detail.photos.find((p: { filename: string }) => p.filename === "one.jpg");

    // Re-export: same name, new pixels → same photo, new version.
    await jpeg(path.join(dir, "one.jpg"), green);
    fs.utimesSync(path.join(dir, "one.jpg"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    await app.ctx.galleries.scan();
    await app.ctx.jobs.drain();
    let photos = (await studio("GET", `/galleries/${id}`)).json().photos;
    const reexported = photos.find((p: { id: string }) => p.id === one.id);
    expect(reexported.filename).toBe("one.jpg");
    expect(reexported.thumb).not.toBe(one.thumb);

    // Rename: same pixels, new name → same photo.
    fs.renameSync(path.join(dir, "two.jpg"), path.join(dir, "two-renamed.jpg"));
    const two = photos.find((p: { filename: string }) => p.filename === "two.jpg");
    await app.ctx.galleries.scan();
    photos = (await studio("GET", `/galleries/${id}`)).json().photos;
    expect(photos.find((p: { id: string }) => p.id === two.id).filename).toBe("two-renamed.jpg");

    // Delete: kept as missing so favorites survive a re-export that briefly removes files.
    fs.rmSync(path.join(dir, "one.jpg"));
    await app.ctx.galleries.scan();
    photos = (await studio("GET", `/galleries/${id}`)).json().photos;
    expect(photos.find((p: { id: string }) => p.id === one.id).state).toBe("missing");
  });

  it("waits for files that are still being written", async () => {
    const file = path.join(share, "Busy/a.jpg");
    await jpeg(file, red);
    const { id } = await galleryFromShare();
    await sharp({ create: { width: 10, height: 10, channels: 3, background: blue } }).jpeg().toFile(path.join(share, "Busy/b.jpg"));
    const ingest = new (app.ctx.galleries.constructor as typeof import("../src/galleries/ingest.js").GalleryIngest)({
      db: app.ctx.db,
      settings: app.ctx.settings,
      galleriesDir: share,
      settleSeconds: 30,
      logger: app.log,
    });
    const r = await ingest.scan();
    ingest.close();
    expect(r.waiting).toBe(1);
    expect((await studio("GET", `/galleries/${id}`)).json().photos).toHaveLength(1);
  });
});

describe("client gallery", () => {
  it("is hidden until published, then shows sets and photos", async () => {
    await jpeg(path.join(share, "Kim/Gallery/Highlights/a.jpg"), red);
    await jpeg(path.join(share, "Kim/Gallery/Full/b.jpg"), blue);
    const { id, slug } = await galleryFromShare();
    expect((await app.inject(`/api/g/${slug}`)).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/g/${slug}`, headers: { cookie: staff } })).json().gallery.preview).toBe(true);

    expect((await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" })).statusCode).toBe(200);
    const page = (await app.inject(`/api/g/${slug}`)).json();
    expect(page.gallery).toMatchObject({ title: "Kim", preview: false });
    expect(page.sets.map((s: { name: string }) => s.name).sort()).toEqual(["Full", "Highlights"]);
    expect(page.photos).toHaveLength(2);
    expect(page.me).toEqual({ email: null, selections: [] });
    expect(page.studio.name).toBe("Test Studio");
  });

  it("asks for an email at the first favorite, enforces list caps, and locks a list once sent", async () => {
    await jpeg(path.join(share, "Ng/a.jpg"), red);
    await jpeg(path.join(share, "Ng/b.jpg"), blue);
    const { id, slug, detail } = await galleryFromShare();
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    const listId = detail.lists[0].id;
    await studio("PATCH", `/galleries/${id}/lists/${listId}`, { maxCount: 1 });
    const [a, b] = detail.photos.map((p: { id: string }) => p.id);

    expect((await app.inject({ method: "PUT", url: `/api/g/${slug}/lists/${listId}/photos/${a}` })).statusCode).toBe(401);
    const who = await app.inject({ method: "POST", url: `/api/g/${slug}/identify`, payload: { email: "Client@Example.com" } });
    const cookie = `op_client=${who.cookies.find((c) => c.name === "op_client")!.value}`;
    const fav = (photoId: string, method: "PUT" | "DELETE" = "PUT") => app.inject({ method, url: `/api/g/${slug}/lists/${listId}/photos/${photoId}`, headers: { cookie }, payload: {} });

    expect((await fav(a)).json().me.selections[0]).toMatchObject({ photoIds: [a], submittedAt: null });
    expect((await fav(b)).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/g/${slug}/lists/${listId}/submit`, headers: { cookie } })).statusCode).toBe(200);
    expect((await fav(a, "DELETE")).json().error).toBe("submitted");

    const { selections } = (await studio("GET", `/galleries/${id}/favorites`)).json();
    expect(selections[0]).toMatchObject({ clientEmail: "client@example.com", listName: "Favorites", items: [{ photoId: a, filename: "a.jpg" }] });
    expect(selections[0].submittedAt).toBeTypeOf("number");

    // A forged cookie is not an identity.
    expect((await app.inject({ method: "PUT", url: `/api/g/${slug}/lists/${listId}/photos/${b}`, headers: { cookie: "op_client=Y2xpZW50QGV4YW1wbGUuY29t.forged" } })).statusCode).toBe(401);
  });

  it("follows the download lock chosen at publish", async () => {
    await jpeg(path.join(share, "Diaz/Gallery/Highlights/a.jpg"), red);
    await jpeg(path.join(share, "Diaz/Gallery/Full/b.jpg"), blue);
    const { id, slug, detail } = await galleryFromShare();
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "highlights_early" });
    const highlights = detail.sets.find((s: { name: string }) => s.name === "Highlights");
    await studio("PATCH", `/galleries/${id}/sets/${highlights.id}`, { earlyDownload: true });
    const who = await app.inject({ method: "POST", url: `/api/g/${slug}/identify`, payload: { email: "c@example.com" } });
    const cookie = `op_client=${who.cookies.find((c) => c.name === "op_client")!.value}`;
    const dl = (filename: string) => {
      const p = detail.photos.find((x: { filename: string }) => x.filename === filename);
      return app.inject({ url: `/api/g/${slug}/photos/${p.id}/download`, headers: { cookie } });
    };

    const early = await dl("a.jpg");
    expect(early.statusCode).toBe(200);
    expect(early.headers["content-disposition"]).toContain('filename="a.jpg"');
    expect((await dl("b.jpg")).statusCode).toBe(403);
    await studio("POST", `/galleries/${id}/unlock`, {});
    expect((await dl("b.jpg")).statusCode).toBe(200);

    await studio("PATCH", `/galleries/${id}`, { downloadSize: "web" });
    const web = await dl("b.jpg");
    expect(web.headers["content-type"]).toBe("image/jpeg");
    expect(web.headers["content-disposition"]).toContain('filename="b.jpg"');
  });
});

describe("gallery settings", () => {
  it("lets the owner rename the delivery folder and choose the default lock", async () => {
    const res = await studio("PUT", "/ingest/settings", { deliveryFolder: "Finals", privateFolders: ["Originals", "Culls"], defaultDownloadLock: "until_paid" });
    expect(res.statusCode).toBe(200);
    expect((await studio("GET", "/ingest/settings")).json()).toEqual({ deliveryFolder: "Finals", privateFolders: ["Originals", "Culls"], defaultDownloadLock: "until_paid" });
    expect((await studio("PUT", "/ingest/settings", { deliveryFolder: "../x", privateFolders: [], defaultDownloadLock: "none" })).statusCode).toBe(400);

    await jpeg(path.join(share, "Ortiz/Finals/a.jpg"), red);
    const { detail } = await galleryFromShare();
    expect(detail.gallery).toMatchObject({ folderPath: "Ortiz/Finals", downloadLock: "until_paid" });
  });
});
