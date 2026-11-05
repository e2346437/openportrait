import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { tickCheckouts } from "../src/domain/storage-checkout.js";

let app: FastifyInstance;
let root: string;
let share: string;
let staff: string;

const past = () => new Date(Date.now() - 3_600_000);
function put(rel: string, bytes: Buffer) {
  const file = path.join(share, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, past(), past());
  return file;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-checkout-"));
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

const studio = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url: `/api/studio${url}`, payload, headers: { cookie: staff } });
const ctx = () => ({ db: app.ctx.db, settings: app.ctx.settings, config: app.ctx.config, actorId: null });

/** A gallery with one image and two RAW files, all moved offsite, with a stand-in store attached. */
async function setup() {
  const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 90, b: 200 } } }).jpeg().toBuffer();
  put("Kim/a.jpg", jpg);
  put("Kim/Originals/RAW/IMG_0001.NEF", Buffer.alloc(5000, 1));
  put("Kim/Originals/RAW/IMG_0002.NEF", Buffer.alloc(7000, 2));
  await studio("POST", "/ingest/rescan");
  const folders = (await studio("GET", "/ingest/folders")).json().folders;
  const id = (await studio("POST", `/ingest/folders/${folders[0].id}/gallery`, {})).json().galleryId as string;
  await app.ctx.jobs.drain();
  await app.ctx.galleries.scan();
  const o = app.ctx.originals;
  o.setStore({ get: async () => { throw new Error("unused"); }, delete: async () => {} });
  for (const r of o.raw.pending(10, 0)) o.raw.markRemote(r.id, `k/${r.id}`, { sizeBytes: r.sizeBytes });
  for (const p of o.pending(10, 0)) o.markRemote(p.id, `k/${p.id}`, { sizeBytes: p.sizeBytes });
  return id;
}

/** What an extension does when it brings a file back: write it, then mark it local. */
function bringAllBack() {
  const o = app.ctx.originals;
  for (const r of o.raw.remote(50, "Kim")) {
    fs.writeFileSync(r.file, Buffer.alloc(r.sizeBytes, 1));
    o.raw.markLocal(r.id);
  }
}

describe("Check Out", () => {
  it("keeps the files local while checked out, reports progress, and tells the owner when ready", async () => {
    const id = await setup();
    const res = await studio("POST", `/galleries/${id}/checkout`, { folders: "originals" });
    expect(res.statusCode).toBe(200);
    expect(res.json().gallery.storageOriginals).toBe("local");
    expect(res.json().gallery.storageGallery).toBe("default");
    expect(res.json().storage.checkout).toMatchObject({ state: "preparing", folders: "originals", totalFiles: 2, doneFiles: 0, returnDays: 14 });
    // Not ready until the last file is back.
    tickCheckouts(ctx(), app.ctx.originals);
    expect((await studio("GET", `/galleries/${id}`)).json().storage.checkout.state).toBe("preparing");
    bringAllBack();
    tickCheckouts(ctx(), app.ctx.originals);
    const view = (await studio("GET", `/galleries/${id}`)).json().storage.checkout;
    expect(view).toMatchObject({ state: "ready", doneFiles: 2, remainingFiles: 0 });
    expect(view.returnsAt).toBeGreaterThan(Date.now());
  });

  it("refuses sensible cases: nothing offsite, already out, no store, and changes while out", async () => {
    const id = await setup();
    expect((await studio("POST", `/galleries/${id}/checkin`)).statusCode).toBe(409);
    expect((await studio("POST", `/galleries/${id}/checkout`, { folders: "nonsense" })).statusCode).toBe(400);
    expect((await studio("POST", `/galleries/${id}/checkout`, { folders: "both" })).statusCode).toBe(200);
    expect((await studio("POST", `/galleries/${id}/checkout`, { folders: "both" })).json().error).toBe("already_checked_out");
    expect((await studio("PATCH", `/galleries/${id}`, { storageOriginals: "offsite" })).statusCode).toBe(409);
    app.ctx.originals.setStore(null);
    await studio("POST", `/galleries/${id}/checkin`);
    expect((await studio("POST", `/galleries/${id}/checkout`, { folders: "both" })).json().error).toBe("no_storage");
  });

  it("checks in to the choices the shoot had before", async () => {
    const id = await setup();
    await studio("PATCH", `/galleries/${id}`, { storageOriginals: "offsite", storageGallery: "default" });
    await studio("POST", `/galleries/${id}/checkout`, { folders: "both" });
    const back = (await studio("POST", `/galleries/${id}/checkin`)).json();
    expect(back.gallery).toMatchObject({ storageOriginals: "offsite", storageGallery: "default" });
    expect(back.storage.checkout.state).toBe("none");
  });

  it("returns offsite by itself after the idle period", async () => {
    const id = await setup();
    await studio("POST", `/galleries/${id}/checkout`, { folders: "originals", returnDays: 3 });
    bringAllBack();
    tickCheckouts(ctx(), app.ctx.originals);
    tickCheckouts(ctx(), app.ctx.originals);
    expect((await studio("GET", `/galleries/${id}`)).json().storage.checkout.state).toBe("ready");
    // Pretend the last change was four days ago.
    const old = new Date(Date.now() - 4 * 86_400_000);
    app.ctx.db.update(tables.gallery).set({ checkedOutAt: old, checkoutReadyAt: old }).where(eq(tables.gallery.id, id)).run();
    app.ctx.db.update(tables.rawFile).set({ mtimeMs: old.getTime() }).run();
    app.ctx.db.update(tables.photo).set({ mtimeMs: old.getTime() }).run();
    tickCheckouts(ctx(), app.ctx.originals);
    const after = (await studio("GET", `/galleries/${id}`)).json();
    expect(after.storage.checkout.state).toBe("none");
    expect(after.gallery.storageOriginals).toBe("default");
  });
});
