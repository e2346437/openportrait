import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let root: string;
let share: string;
let staff: string;

const past = () => new Date(Date.now() - 3_600_000);
function put(rel: string, bytes: Buffer | string) {
  const file = path.join(share, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, past(), past());
  return file;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-raw-"));
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

/** A gallery for the folder "Kim" with one delivered image, plus two RAW files and some noise in Originals/RAW. */
async function setup() {
  const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 90, b: 200 } } }).jpeg().toBuffer();
  put("Kim/a.jpg", jpg);
  put("Kim/Originals/RAW/IMG_0001.NEF", Buffer.alloc(5000, 1));
  put("Kim/Originals/RAW/day2/IMG_0002.NEF", Buffer.alloc(7000, 2));
  put("Kim/Originals/RAW/.hidden", "x");
  put("Kim/Originals/RAW/IMG_0003.NEF.part", "x");
  await studio("POST", "/ingest/rescan");
  const folders = (await studio("GET", "/ingest/folders")).json().folders;
  const created = (await studio("POST", `/ingest/folders/${folders[0].id}/gallery`, {})).json();
  await app.ctx.jobs.drain();
  await app.ctx.galleries.scan();
  return created.galleryId as string;
}

describe("Originals folder tracking", () => {
  it("tracks RAW files, skips hidden and half-written ones, and never turns them into photos", async () => {
    const id = await setup();
    const o = app.ctx.originals;
    expect(o.raw.counts()).toEqual({ local: 2, remote: 0, localBytes: 12000, remoteBytes: 0 });
    const detail = (await studio("GET", `/galleries/${id}`)).json();
    expect(detail.photos).toHaveLength(1);
    expect(detail.storage).toMatchObject({ attached: false, originals: { local: 2, remote: 0 }, gallery: { local: 1, remote: 0 } });
  });

  it("moves a RAW file out, leaves it alone on rescan, and forgets files that were deleted", async () => {
    await setup();
    const o = app.ctx.originals;
    const [a] = o.raw.pending(5, 0).filter((r) => r.relPath.endsWith("IMG_0001.NEF"));
    expect(o.raw.markRemote(a!.id, "k/IMG_0001.NEF", { sizeBytes: 4999 })).toBe(false); // size changed: refuse
    expect(o.raw.markRemote(a!.id, "k/IMG_0001.NEF", { sizeBytes: a!.sizeBytes })).toBe(true);
    expect(fs.existsSync(a!.file)).toBe(false);
    fs.rmSync(path.join(share, "Kim/Originals/RAW/day2/IMG_0002.NEF"));
    await app.ctx.galleries.scan();
    expect(o.raw.counts()).toEqual({ local: 0, remote: 1, localBytes: 0, remoteBytes: 5000 });
    expect(o.raw.remote(10, "Kim")).toHaveLength(1);
    expect(o.raw.remote(10, "Other")).toHaveLength(0);
    // Bring it back.
    fs.writeFileSync(a!.file, Buffer.alloc(5000, 1));
    expect(o.raw.markLocal(a!.id)).toBe(true);
    expect(o.raw.counts()).toMatchObject({ local: 1, remote: 0 });
  });

  it("waits for files to settle", async () => {
    await setup();
    put("Kim/Originals/RAW/IMG_0009.NEF", Buffer.alloc(100, 3));
    fs.utimesSync(path.join(share, "Kim/Originals/RAW/IMG_0009.NEF"), new Date(), new Date());
    await app.ctx.galleries.scan();
    expect(app.ctx.originals.raw.pending(10).map((r) => path.basename(r.relPath))).not.toContain("IMG_0009.NEF");
    expect(app.ctx.originals.raw.pending(10, 0).map((r) => path.basename(r.relPath))).toContain("IMG_0009.NEF");
  });
});

describe("per-gallery storage choice", () => {
  it("is saved through the gallery settings and rejects unknown values", async () => {
    const id = await setup();
    const ok = await studio("PATCH", `/galleries/${id}`, { storageOriginals: "local", storageGallery: "offsite" });
    expect(ok.json().gallery).toMatchObject({ storageOriginals: "local", storageGallery: "offsite" });
    expect((await studio("PATCH", `/galleries/${id}`, { storageOriginals: "cloud" })).statusCode).toBe(400);
  });

  it("decides what an extension is offered: local is never moved, offsite always is", async () => {
    const id = await setup();
    const o = app.ctx.originals;
    const names = (xs: Array<{ relPath: string }>) => xs.map((x) => path.basename(x.relPath)).sort();
    // Studio default on: everything, until the gallery says local.
    expect(names(o.raw.pending(10, 0, true))).toHaveLength(2);
    expect(o.pending(10, 0, true)).toHaveLength(1);
    await studio("PATCH", `/galleries/${id}`, { storageOriginals: "local", storageGallery: "local" });
    expect(o.raw.pending(10, 0, true)).toHaveLength(0);
    expect(o.pending(10, 0, true)).toHaveLength(0);
    // Studio default off: nothing, until the gallery says offsite.
    await studio("PATCH", `/galleries/${id}`, { storageOriginals: "default", storageGallery: "default" });
    expect(o.raw.pending(10, 0, false)).toHaveLength(0);
    expect(o.pending(10, 0, false)).toHaveLength(0);
    await studio("PATCH", `/galleries/${id}`, { storageOriginals: "offsite" });
    expect(o.raw.pending(10, 0, false)).toHaveLength(2);
    expect(o.pending(10, 0, false)).toHaveLength(0); // the delivered images still follow the default
  });

  it("lists stored files whose gallery asks to keep them local, so an extension can bring them back", async () => {
    const id = await setup();
    const o = app.ctx.originals;
    const [r] = o.raw.pending(1, 0);
    o.raw.markRemote(r!.id, "k/r", { sizeBytes: r!.sizeBytes });
    const [p] = o.pending(1, 0);
    o.markRemote(p!.id, "k/p", { sizeBytes: p!.sizeBytes });
    expect(o.raw.wantedLocal(10)).toHaveLength(0);
    expect(o.wantedLocal(10)).toHaveLength(0);
    await studio("PATCH", `/galleries/${id}`, { storageOriginals: "local" });
    expect(o.raw.wantedLocal(10).map((x) => x.id)).toEqual([r!.id]);
    expect(o.wantedLocal(10)).toHaveLength(0); // the delivered images did not ask for it
    await studio("PATCH", `/galleries/${id}`, { storageGallery: "local" });
    expect(o.wantedLocal(10).map((x) => x.id)).toEqual([p!.id]);
  });
});
