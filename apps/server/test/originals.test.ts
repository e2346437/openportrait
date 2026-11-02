import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { tables } from "@openportrait/db";
import { buildApp } from "../src/app.js";
import type { OriginalStore } from "../src/galleries/originals.js";

let app: FastifyInstance;
let root: string;
let share: string;
let staff: string;
const objects = new Map<string, Buffer>();
const deleted: string[] = [];

const store: OriginalStore = {
  async get(key) {
    const b = objects.get(key);
    if (!b) throw new Error("no such key");
    return { stream: Readable.from([b]), size: b.length };
  },
  async delete(key) {
    deleted.push(key);
    objects.delete(key);
  },
};

async function jpeg(file: string, color: { r: number; g: number; b: number }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).jpeg().toFile(file);
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, past, past);
}

beforeEach(async () => {
  objects.clear();
  deleted.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-orig-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), INGEST_SETTLE_SECONDS: "0" });
  share = config.galleriesDir;
  fs.mkdirSync(share, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Test Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  staff = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const studio = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method, url: `/api/studio${url}`, payload, headers: { cookie: staff } });

async function setup() {
  await jpeg(path.join(share, "Kim/a.jpg"), { r: 200, g: 30, b: 30 });
  await studio("POST", "/ingest/rescan");
  const folders = (await studio("GET", "/ingest/folders")).json().folders;
  const created = (await studio("POST", `/ingest/folders/${folders[0].id}/gallery`, {})).json();
  await app.ctx.jobs.drain();
  const id = created.galleryId as string;
  await studio("POST", `/galleries/${id}/publish`, { downloadLock: "until_paid" });
  const detail = (await studio("GET", `/galleries/${id}`)).json();
  const who = await app.inject({ method: "POST", url: `/api/g/${detail.gallery.slug}/identify`, payload: { email: "kim@example.com" } });
  return { id, slug: detail.gallery.slug as string, photo: detail.photos[0], cookie: `op_client=${who.cookies.find((c) => c.name === "op_client")!.value}` };
}

/** Moves the one photo's original into the fake store, as an extension would. */
function offload(photoId: string) {
  app.ctx.originals.setStore(store);
  const [item] = app.ctx.originals.pending(5, 0);
  expect(item!.id).toBe(photoId);
  const bytes = fs.readFileSync(item!.file);
  objects.set("k1", bytes);
  expect(app.ctx.originals.markRemote(photoId, "k1", { sizeBytes: item!.sizeBytes })).toBe(true);
  return { item: item!, bytes };
}

describe("remote originals", () => {
  it("serves downloads from the store, still behind the payment lock", async () => {
    const { id, slug, photo, cookie } = await setup();
    const { item, bytes } = offload(photo.id);
    expect(fs.existsSync(item.file)).toBe(false);

    const dl = () => app.inject({ url: `/api/g/${slug}/photos/${photo.id}/download`, headers: { cookie } });
    expect((await dl()).statusCode).toBe(403); // locked: the store is never reached
    await studio("POST", `/galleries/${id}/unlock`, {});
    const ok = await dl();
    expect(ok.statusCode).toBe(200);
    expect(Buffer.compare(ok.rawPayload, bytes)).toBe(0);
    expect(ok.headers["content-length"]).toBe(String(bytes.length));

    const zip = await app.inject({ url: `/api/g/${slug}/zip?scope=gallery`, headers: { cookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(zip.rawPayload.length).toBeGreaterThan(bytes.length);
  });

  it("keeps the photo in the gallery after a rescan and rebuilds previews from the store", async () => {
    const { id, photo } = await setup();
    offload(photo.id);
    await studio("POST", "/ingest/rescan");
    await app.ctx.galleries.syncGallery(id);
    expect(app.ctx.db.select().from(tables.photo).where(eq(tables.photo.id, photo.id)).get()?.state).toBe("ready");

    fs.rmSync(app.ctx.config.cacheDir, { recursive: true, force: true });
    const url = (await studio("GET", `/galleries/${id}`)).json().photos[0].thumb as string;
    const res = await app.inject({ url, headers: { cookie: staff } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
  });

  it("answers 503 and loses nothing when the store is detached", async () => {
    const { id, slug, photo, cookie } = await setup();
    offload(photo.id);
    app.ctx.originals.setStore(null);
    await studio("POST", `/galleries/${id}/unlock`, {});
    expect((await app.inject({ url: `/api/g/${slug}/photos/${photo.id}/download`, headers: { cookie } })).statusCode).toBe(503);
    expect(objects.has("k1")).toBe(true);
    expect(app.ctx.db.select().from(tables.photo).where(eq(tables.photo.id, photo.id)).get()?.remoteKey).toBe("k1");
  });

  it("refuses to free a local file that changed after it was listed", async () => {
    const { photo } = await setup();
    app.ctx.originals.setStore(store);
    const [item] = app.ctx.originals.pending(5, 0);
    expect(app.ctx.originals.markRemote(photo.id, "k1", { sizeBytes: item!.sizeBytes + 1 })).toBe(false);
    expect(fs.existsSync(item!.file)).toBe(true);
  });

  it("deletes the stored copy when the photo is deleted, and drops it when a new file replaces it", async () => {
    const { id, photo } = await setup();
    offload(photo.id);
    expect((await studio("DELETE", `/galleries/${id}/photos/${photo.id}`)).statusCode).toBe(200);
    expect(deleted).toEqual(["k1"]);
  });

  it("clears the stored copy when the file is re-exported locally", async () => {
    const { id, photo } = await setup();
    offload(photo.id);
    await jpeg(path.join(share, "Kim/a.jpg"), { r: 10, g: 200, b: 10 });
    await app.ctx.galleries.syncGallery(id);
    await Promise.resolve();
    const row = app.ctx.db.select().from(tables.photo).where(eq(tables.photo.id, photo.id)).get();
    expect(row?.remoteKey).toBeNull();
    expect(deleted).toEqual(["k1"]);
  });

  it("brings an original back to the galleries folder and counts both kinds", async () => {
    const { photo } = await setup();
    const { item, bytes } = offload(photo.id);
    expect(app.ctx.originals.counts()).toEqual({ local: 0, remote: 1 });
    const [r] = app.ctx.originals.remote(5);
    expect(r).toMatchObject({ id: photo.id, remoteKey: "k1", file: item.file });
    expect(app.ctx.originals.markLocal(photo.id)).toBe(false); // nothing written yet: refused
    fs.writeFileSync(r!.file, bytes);
    expect(app.ctx.originals.markLocal(photo.id)).toBe(true);
    expect(app.ctx.originals.counts()).toEqual({ local: 1, remote: 0 });
  });
});
