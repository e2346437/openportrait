import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { sampleBase, renderWatermarkedBuffer, watermarkHash, DEFAULT_WATERMARK, WatermarkSpec, type WatermarkInput } from "../src/galleries/watermark.js";

let app: FastifyInstance;
let root: string;
let staff: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-wm-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Test Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  staff = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const api = (method: "GET" | "PUT" | "DELETE", url: string, payload?: object | Buffer, type?: string) =>
  app.inject({ method, url: `/api/studio/watermark${url}`, payload, headers: { cookie: staff, ...(type ? { "content-type": type } : {}) } });
const query = (o: Record<string, string | number>) => "/preview?" + new URLSearchParams(Object.entries({ mode: "text", font: "inter", style: "bold", color: "#ffffff", textSize: 60, size: 24, opacity: 45, position: "tile", text: "Studio", ...o }).map(([k, v]) => [k, String(v)])).toString();
const pixels = async (b: Buffer) => sharp(b).raw().toBuffer();

describe("watermark settings", () => {
  it("starts on the defaults and saves a new look", async () => {
    const first = (await api("GET", "/")).json();
    expect(first.spec).toMatchObject({ mode: "text", font: "inter", position: "tile" });
    expect(first.fonts.length).toBeGreaterThan(3);
    const spec = { ...DEFAULT_WATERMARK, font: "lora", color: "#112233", position: "bottom-right", opacity: 70 };
    const res = await api("PUT", "/", { spec, text: "ODA" });
    expect(res.statusCode).toBe(200);
    expect((await api("GET", "/")).json()).toMatchObject({ spec: { font: "lora", color: "#112233", position: "bottom-right", opacity: 70 }, text: "ODA" });
    // The folder settings form no longer overwrites the wording unless it sends it.
    await app.inject({ method: "PUT", url: "/api/studio/ingest/settings", headers: { cookie: staff }, payload: { deliveryFolder: "Gallery", privateFolders: ["Originals"], defaultDownloadLock: "none" } });
    expect((await api("GET", "/")).json().text).toBe("ODA");
  });

  it("refuses values outside the allowed range", async () => {
    const bad = await api("PUT", "/", { spec: { ...DEFAULT_WATERMARK, color: "red" }, text: "" });
    expect(bad.statusCode).toBe(400);
    expect((await api("PUT", "/", { spec: { ...DEFAULT_WATERMARK, opacity: 0 }, text: "" })).statusCode).toBe(400);
    expect((await api("PUT", "/", { spec: { ...DEFAULT_WATERMARK, font: "comic-sans" }, text: "" })).statusCode).toBe(400);
  });
});

describe("watermark preview", () => {
  it("draws a sample photo, and the look changes the pixels", async () => {
    const base = await api("GET", query({}));
    expect(base.statusCode).toBe(200);
    expect(base.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(base.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 800]);
    for (const change of [{ font: "playfair-display" }, { color: "#000000" }, { position: "top-left" }, { style: "italic" }, { text: "Something longer here" }, { textSize: 120 }]) {
      const other = await api("GET", query(change));
      expect(other.statusCode, JSON.stringify(change)).toBe(200);
      expect((await pixels(other.rawPayload)).equals(await pixels(base.rawPayload)), JSON.stringify(change)).toBe(false);
    }
  });

  it("rejects an invalid look", async () => {
    expect((await api("GET", query({ color: "nope" }))).statusCode).toBe(400);
    expect((await api("GET", query({ textSize: 9999 }))).statusCode).toBe(400);
  });
});

describe("custom image", () => {
  it("accepts a transparent PNG, scales it to the photo, and can be removed", async () => {
    expect((await api("PUT", "/image", Buffer.from("not an image"), "image/png")).statusCode).toBe(400);
    const png = await sharp({ create: { width: 2400, height: 800, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const up = await api("PUT", "/image", png, "image/png");
    expect(up.statusCode).toBe(200);
    expect(up.json().image).toMatch(/^\/api\/studio\/watermark\/image\?v=\d+$/);
    // Stored at most 1200 px wide.
    const stored = await sharp(fs.readFileSync(path.join(root, "config", "watermark.png"))).metadata();
    expect(stored.width).toBe(1200);
    const marked = await api("GET", query({ mode: "image", size: 30, opacity: 100, position: "center" }));
    const plain = await api("GET", query({ mode: "text", position: "tile", opacity: 10 }));
    expect(marked.statusCode).toBe(200);
    // A 30% wide image on a 1200 px sample covers about 360 px: the middle of the picture is now red-heavy.
    const { data, info } = await sharp(marked.rawPayload).raw().toBuffer({ resolveWithObject: true });
    const mid = (info.height / 2) * info.width * info.channels + (info.width / 2) * info.channels;
    expect(data[mid]).toBeGreaterThan(200);
    expect(data[mid + 1]).toBeLessThan(60);
    expect((await pixels(plain.rawPayload)).equals(data)).toBe(false);
    const gone = await api("DELETE", "/image");
    expect(gone.json().image).toBeNull();
    expect((await api("GET", "/image")).statusCode).toBe(404);
  });

  it("falls back to the wording when the image is missing", async () => {
    const res = await api("GET", query({ mode: "logo", position: "bottom" }));
    expect(res.statusCode).toBe(200);
    expect((await pixels(res.rawPayload)).equals(await pixels((await api("GET", query({ mode: "text", position: "bottom" }))).rawPayload))).toBe(true);
  });
});

describe("fingerprint and renderer", () => {
  const input = (over: Partial<WatermarkInput> = {}): WatermarkInput => ({ spec: DEFAULT_WATERMARK, text: "A", logoFile: null, imageFile: null, logoVersion: 0, imageVersion: 0, ...over });
  it("changes with anything that changes how the mark looks, and not with unrelated state", () => {
    const base = watermarkHash(input());
    expect(base).toMatch(/^[a-f0-9]{8}$/);
    expect(watermarkHash(input({ text: "B" }))).not.toBe(base);
    expect(watermarkHash(input({ spec: { ...DEFAULT_WATERMARK, color: "#000000" } }))).not.toBe(base);
    expect(watermarkHash(input({ imageVersion: 5 }))).toBe(base); // image version only matters in image mode
    expect(watermarkHash(input({ spec: { ...DEFAULT_WATERMARK, mode: "image" }, imageVersion: 5 }))).not.toBe(watermarkHash(input({ spec: { ...DEFAULT_WATERMARK, mode: "image" }, imageVersion: 6 })));
  });
  it("scales the mark with the photo, so a small preview carries the same proportions", async () => {
    const big = await sampleBase();
    const small = await sharp(big).resize({ width: 300 }).jpeg().toBuffer();
    const spec = WatermarkSpec.parse({ position: "bottom-right", opacity: 100 });
    const a = await renderWatermarkedBuffer(big, input({ spec, text: "Studio" }));
    const b = await renderWatermarkedBuffer(small, input({ spec, text: "Studio" }));
    expect((await sharp(a).metadata()).width).toBe(1200);
    expect((await sharp(b).metadata()).width).toBe(300);
  });
});
