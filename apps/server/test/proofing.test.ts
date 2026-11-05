import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { DEFAULT_PROOFING, edgeOf, PRESETS, proofFingerprint, renderProtectedBuffer, resolveProofing, rng } from "../src/galleries/proofing.js";
import { DEFAULT_WATERMARK, sampleBase, type WatermarkInput } from "../src/galleries/watermark.js";

let app: FastifyInstance;
let root: string;
let staff: string;
let share: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-pf-"));
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

const studio = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) => app.inject({ method, url: `/api/studio${url}`, payload, headers: { cookie: staff } });
const wm: WatermarkInput = { spec: DEFAULT_WATERMARK, text: "Oda Studio", logoFile: null, imageFile: null, logoVersion: 0, imageVersion: 0 };
const raw = (b: Buffer) => sharp(b).raw().toBuffer();

async function photoFile(file: string, width = 2400, height = 1600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Some structure so a mark is visible against it.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#7a8a99"/><circle cx="${width / 2}" cy="${height / 2}" r="${height / 3}" fill="#d9c7a3"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg().toFile(file);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
}

async function publishedGallery(lock: "none" | "until_paid") {
  await photoFile(path.join(share, "Oda Family", "Full/f1.jpg"));
  await studio("POST", "/ingest/rescan");
  const folders = (await studio("GET", "/ingest/folders")).json().folders;
  const created = (await studio("POST", `/ingest/folders/${folders[0].id}/gallery`, {})).json();
  await app.ctx.jobs.drain();
  const id = created.galleryId as string;
  await studio("POST", `/galleries/${id}/publish`, { downloadLock: lock });
  const slug = (await studio("GET", `/galleries/${id}`)).json().gallery.slug as string;
  const page = async () => (await app.inject({ method: "GET", url: `/api/g/${slug}` })).json();
  const photoUrls = async () => (await page()).photos[0] as { preview: string; thumb: string };
  return { id, slug, page, photoUrls };
}

describe("policy", () => {
  it("defaults to Balanced and only while downloads are locked, so nothing changes on update", () => {
    expect(DEFAULT_PROOFING).toEqual({ mode: "balanced", apply: "locked", maxLongEdge: null });
    expect(edgeOf(DEFAULT_PROOFING)).toBe(PRESETS.balanced.longEdge);
  });

  it("layers a gallery over the studio default, and ignores junk", () => {
    expect(resolveProofing({ mode: "strong" }, { apply: "always" })).toEqual({ mode: "strong", apply: "always", maxLongEdge: null });
    expect(resolveProofing({ mode: "strong", maxLongEdge: 900 }, { maxLongEdge: null }).maxLongEdge).toBeNull();
    expect(resolveProofing({ mode: "nonsense" }, { apply: 5 })).toEqual(DEFAULT_PROOFING);
  });

  it("changes the fingerprint when the look changes, but not when only `apply` does", () => {
    const a = proofFingerprint(DEFAULT_PROOFING, wm);
    expect(proofFingerprint({ ...DEFAULT_PROOFING, apply: "always" }, wm)).toBe(a);
    expect(proofFingerprint({ ...DEFAULT_PROOFING, mode: "strong" }, wm)).not.toBe(a);
    expect(proofFingerprint({ ...DEFAULT_PROOFING, maxLongEdge: 900 }, wm)).not.toBe(a);
    expect(proofFingerprint(DEFAULT_PROOFING, { ...wm, text: "Other" })).not.toBe(a);
  });

  it("validates the studio default on save", async () => {
    expect((await studio("PUT", "/proofing", { mode: "strong", apply: "always" })).json().policy).toEqual({ mode: "strong", apply: "always", maxLongEdge: null });
    expect((await studio("PUT", "/proofing", { maxLongEdge: 100 })).statusCode).toBe(400);
    expect((await studio("PUT", "/proofing", { mode: "extreme" })).statusCode).toBe(400);
  });
});

describe("renderer", () => {
  it("is deterministic for a seed, different for another, and capped to the preset's size", async () => {
    const base = await sampleBase();
    const a = await renderProtectedBuffer(base, wm, DEFAULT_PROOFING, "seed-1");
    const again = await renderProtectedBuffer(base, wm, DEFAULT_PROOFING, "seed-1");
    const other = await renderProtectedBuffer(base, wm, DEFAULT_PROOFING, "seed-2");
    expect((await raw(a)).equals(await raw(again))).toBe(true);
    expect((await raw(a)).equals(await raw(other))).toBe(false);
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#889" } }).jpeg().toBuffer();
    for (const mode of ["light", "balanced", "strong"] as const) {
      const meta = await sharp(await renderProtectedBuffer(big, wm, { ...DEFAULT_PROOFING, mode }, "s")).metadata();
      expect(Math.max(meta.width!, meta.height!)).toBe(PRESETS[mode].longEdge);
      expect(meta.exif).toBeUndefined();
    }
    const small = await sharp(await renderProtectedBuffer(big, wm, { ...DEFAULT_PROOFING, maxLongEdge: 700 }, "s")).metadata();
    expect(small.width).toBe(700);
  });

  it("does not repeat one grid: marks land in different places for different seeds", () => {
    const first = Array.from({ length: 5 }, ((r) => () => r())(rng("a")));
    const second = Array.from({ length: 5 }, ((r) => () => r())(rng("b")));
    expect(first).not.toEqual(second);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it("stronger presets cover more of the photo", async () => {
    const plain = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const cover = async (mode: "light" | "strong") => {
      const px = await raw(await renderProtectedBuffer(plain, wm, { ...DEFAULT_PROOFING, mode, maxLongEdge: 1000 }, "same"));
      let changed = 0;
      for (let i = 0; i < px.length; i += 3) if (Math.abs(px[i]! - 128) > 12) changed++;
      return changed;
    };
    expect(await cover("strong")).toBeGreaterThan(await cover("light"));
  });
});

describe("entitlement and stale URLs", () => {
  it("serves a smaller marked copy while locked, and never lets an old clean URL through", async () => {
    const g = await publishedGallery("none");
    const clean = await g.photoUrls();
    expect(clean.preview).not.toContain("-pf-");
    const cleanRes = await app.inject(clean.preview);
    expect(cleanRes.statusCode).toBe(200);
    expect((await sharp(cleanRes.rawPayload).metadata()).width).toBe(2048);

    // The studio locks the gallery. The clean URL handed out earlier is still signed and unexpired.
    await studio("PATCH", `/galleries/${g.id}`, { downloadLock: "until_paid" });
    const stale = await app.inject(clean.preview);
    expect(stale.statusCode).toBe(200);
    expect((await sharp(stale.rawPayload).metadata()).width).toBe(PRESETS.balanced.longEdge);
    expect(stale.rawPayload.equals(cleanRes.rawPayload)).toBe(false);
    expect(stale.headers["cache-control"]).toBe("private, no-store");

    const locked = await g.photoUrls();
    expect(locked.preview).toContain("preview-pf-");
    const fresh = await app.inject(locked.preview);
    expect(fresh.rawPayload.equals(stale.rawPayload)).toBe(true);

    // Unlocked: clean again, at the clean URL, with the protected URL also resolving to clean (it is now allowed).
    await studio("POST", `/galleries/${g.id}/unlock`, { locked: false });
    const open = await g.photoUrls();
    expect(open.preview).not.toContain("-pf-");
    expect((await sharp((await app.inject(open.preview)).rawPayload).metadata()).width).toBe(2048);
  });

  it("protects previews on its own switch, independent of the download lock", async () => {
    const g = await publishedGallery("none");
    // Always: previews are protected although downloads are not locked, and the lock is untouched.
    await studio("PATCH", `/galleries/${g.id}`, { proofing: { apply: "always", mode: "strong" } });
    const detail = (await studio("GET", `/galleries/${g.id}`)).json().gallery;
    expect(detail.downloadLock).toBe("none");
    expect(detail.proofingEffective).toEqual({ mode: "strong", apply: "always", maxLongEdge: null });
    const url = (await g.photoUrls()).preview;
    expect(url).toContain("-pf-");
    expect((await sharp((await app.inject(url)).rawPayload).metadata()).width).toBe(PRESETS.strong.longEdge);

    // Off: a locked gallery then shows clean previews (the studio's explicit choice); the lock still holds.
    await studio("PATCH", `/galleries/${g.id}`, { proofing: { apply: "off" }, downloadLock: "until_paid" });
    expect((await g.photoUrls()).preview).not.toContain("-pf-");
    expect((await studio("GET", `/galleries/${g.id}`)).json().gallery.downloadLock).toBe("until_paid");

    // Null goes back to the studio default (Balanced, only while locked).
    await studio("PATCH", `/galleries/${g.id}`, { proofing: null });
    expect((await g.photoUrls()).preview).toContain("-pf-");
  });

  it("a changed policy gives new URLs and files, and thumbnails are protected too", async () => {
    const g = await publishedGallery("until_paid");
    const before = await g.photoUrls();
    await studio("PUT", "/proofing", { mode: "strong" });
    const after = await g.photoUrls();
    expect(after.preview).not.toBe(before.preview);
    expect(after.thumb).toContain("thumb-pf-");
    expect((await app.inject(after.thumb)).statusCode).toBe(200);
    // The old URL still resolves, but to the current policy's render, never to a weaker one.
    const old = await app.inject(before.preview);
    expect((await sharp(old.rawPayload).metadata()).width).toBe(PRESETS.strong.longEdge);
    const files = fs.readdirSync(path.join(root, "cache", "galleries", g.id)).filter((n) => n.includes("-pf-"));
    expect(files.every((n) => n.endsWith(`-pf-${new URL(after.preview, "http://x").pathname.split("-pf-")[1]!.slice(0, 8)}.webp`))).toBe(true);
  });

  it("refuses unsigned or tampered flavors", async () => {
    const g = await publishedGallery("until_paid");
    const url = (await g.photoUrls()).preview;
    expect((await app.inject(url.replace("preview-pf-", "preview-"))).statusCode).toBe(404);
    expect((await app.inject(url.replace(/&s=.*/, "&s=abc"))).statusCode).toBe(404);
  });
});
