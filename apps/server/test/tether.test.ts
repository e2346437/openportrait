import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { FolderTracker, isPhotoFile, largestEmbeddedJpeg, scanPhotos, type LandedPhoto, type UploadingFile } from "../src/domain/tether.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-tether-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const jpeg = (w: number, h: number, color = "#c2461f") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
/** Imitates a RAW file: header bytes, a small thumbnail, then a big preview, then trailing data. */
async function fakeRaw() {
  const thumb = await jpeg(160, 120, "#335577");
  const preview = await jpeg(3000, 2000, "#22aa55");
  return { file: Buffer.concat([Buffer.from("II*\0RAWHEADER"), thumb, Buffer.alloc(300, 7), preview, Buffer.alloc(900, 1)]), preview };
}

describe("file detection", () => {
  it("accepts photos and ignores partial or hidden files", () => {
    expect(isPhotoFile("DSC_0001.NEF")).toBe(true);
    expect(isPhotoFile("a.JPG")).toBe(true);
    expect(isPhotoFile("a.jpg.filepart")).toBe(false);
    expect(isPhotoFile(".hidden.jpg")).toBe(false);
    expect(isPhotoFile("notes.txt")).toBe(false);
  });
  it("scans nested folders and skips the delivery folder", () => {
    fs.mkdirSync(path.join(root, "Originals/RAW"), { recursive: true });
    fs.mkdirSync(path.join(root, "Gallery"));
    fs.writeFileSync(path.join(root, "Originals/RAW/a.nef"), "x");
    fs.writeFileSync(path.join(root, "Gallery/b.jpg"), "x");
    expect(scanPhotos(root, ["Gallery"]).map((f) => f.rel)).toEqual(["Originals/RAW/a.nef"]);
  });
});

describe("embedded preview", () => {
  it("picks the big preview, not the nested thumbnail", async () => {
    const { file, preview } = await fakeRaw();
    const found = largestEmbeddedJpeg(file)!;
    expect(found.equals(preview)).toBe(true);
    expect((await sharp(found).metadata()).width).toBe(3000);
  });
  it("returns null when there is no JPEG", () => {
    expect(largestEmbeddedJpeg(Buffer.alloc(10_000, 3))).toBeNull();
  });
});

describe("FolderTracker", () => {
  it("treats existing files as history, then reports growth, progress and the landing", () => {
    fs.writeFileSync(path.join(root, "old.jpg"), Buffer.alloc(1000));
    const t = new FolderTracker(root, [], { pollMs: 1000, settleMs: 1500 });
    const photos: LandedPhoto[] = [];
    const progress: UploadingFile[][] = [];
    const un = t.subscribe({ onPhoto: (p) => photos.push(p), onProgress: (u) => progress.push(u) });
    expect(photos).toEqual([]);
    expect(t.snapshot().total).toBe(1);

    const f = path.join(root, "new.jpg");
    let now = Date.now();
    fs.writeFileSync(f, Buffer.alloc(100));
    t.tick((now += 1000)); // first sight
    fs.appendFileSync(f, Buffer.alloc(400));
    t.tick((now += 1000)); // growing
    expect(progress.at(-1)![0]).toMatchObject({ id: "new.jpg", bytes: 500, rate: 400 });
    t.tick((now += 1000)); // unchanged, not settled yet
    expect(photos).toHaveLength(0);
    t.tick((now += 1000)); // settled
    expect(photos.map((p) => p.id)).toEqual(["new.jpg"]);
    expect(progress.at(-1)).toEqual([]); // the bar clears once
    const n = progress.length;
    t.tick((now += 1000));
    expect(progress).toHaveLength(n);
    expect(t.snapshot().latest?.id).toBe("new.jpg");
    un();
    expect(t.size).toBe(0);
  });
});

describe("tether routes", () => {
  let app: FastifyInstance;
  let cookie: string;
  let base: string;
  beforeEach(async () => {
    const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
    fs.mkdirSync(config.incomingDir, { recursive: true });
    app = await buildApp({ config, startBackground: false, logger: false });
    const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "T", ownerName: "Pat", email: "p@example.com", password: "correct horse battery", timezone: "UTC" } });
    cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it("requires sign-in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/studio/tether/sources" });
    expect(res.statusCode).toBe(401);
  });

  it("lists sources and serves a RAW preview", async () => {
    const sources = (await app.inject({ method: "GET", url: "/api/studio/tether/sources", headers: { cookie } })).json();
    expect(sources.incoming.label).toBe("Incoming");
    expect(sources.shoots).toEqual([]);

    const { file } = await fakeRaw();
    fs.mkdirSync(path.join(app.ctx.config.incomingDir, "Z9"), { recursive: true });
    fs.writeFileSync(path.join(app.ctx.config.incomingDir, "Z9/DSC_0001.NEF"), file);
    const ok = await app.inject({ method: "GET", url: `/api/studio/tether/incoming/photo?path=${encodeURIComponent("Z9/DSC_0001.NEF")}`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
    expect((await sharp(ok.rawPayload).metadata()).width).toBe(2560);

    const escape = await app.inject({ method: "GET", url: `/api/studio/tether/incoming/photo?path=${encodeURIComponent("../../etc/passwd.jpg")}`, headers: { cookie } });
    expect(escape.statusCode).toBe(400);
    fs.writeFileSync(path.join(app.ctx.config.incomingDir, "bad.nef"), Buffer.alloc(9000, 2));
    const none = await app.inject({ method: "GET", url: `/api/studio/tether/incoming/photo?path=bad.nef`, headers: { cookie } });
    expect(none.statusCode).toBe(422);
  });

  it("deletes a disliked photo for good, with its same-named companions, and tells the screen", async () => {
    const dir = path.join(app.ctx.config.incomingDir, "Z9");
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ["DSC_0001.jpg", "DSC_0001.NEF", "DSC_0002.jpg"]) fs.writeFileSync(path.join(dir, n), Buffer.alloc(100, 1));
    const del = (p: string) => app.inject({ method: "DELETE", url: `/api/studio/tether/incoming/photo?path=${encodeURIComponent(p)}`, headers: { cookie } });
    const listed = (await app.inject({ method: "GET", url: "/api/studio/tether/incoming/list", headers: { cookie } })).json().photos;
    expect(listed.map((p: { name: string }) => p.name).sort()).toEqual(["DSC_0001.NEF", "DSC_0001.jpg", "DSC_0002.jpg"]);
    expect((await del("../../etc/passwd.jpg")).statusCode).toBe(400);
    expect((await del("Z9/nope.jpg")).statusCode).toBe(404);
    expect((await del("Z9/DSC_0001.jpg")).json()).toEqual({ ok: true, removed: 2 });
    expect(fs.readdirSync(dir)).toEqual(["DSC_0002.jpg"]);
    expect(fs.existsSync(path.join(dir, ".rejected"))).toBe(false);
  });

  it("streams a photo event when a file lands", async () => {
    const events: Array<{ event: string; data: any }> = [];
    const req = http.get(`${base}/api/studio/tether/incoming/events`, { headers: { cookie } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        for (;;) {
          const i = buf.indexOf("\n\n");
          if (i < 0) break;
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      });
    });
    await vi_waitFor(() => events.some((e) => e.event === "hello"));
    fs.writeFileSync(path.join(app.ctx.config.incomingDir, "IMG_1.jpg"), await jpeg(400, 300));
    await vi_waitFor(() => events.some((e) => e.event === "photo"), 8000);
    const photo = events.find((e) => e.event === "photo")!.data;
    expect(photo).toMatchObject({ id: "IMG_1.jpg", total: 1 });
    req.destroy();
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}
