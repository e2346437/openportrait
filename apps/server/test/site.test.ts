import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { cleanConfig, defaultSite, safeUrl } from "../src/site/config.js";
import { renderSite } from "../src/site/render.js";

let app: FastifyInstance;
let root: string;
let staff: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-site-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), INGEST_SETTLE_SECONDS: "0" });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Photo", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  staff = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const api = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url: `/api/studio/site${url}`, payload, headers: { cookie: staff } });

/** Two galleries with two photos each, so tests can check that only picked photos are exported. */
async function makePhotos() {
  const share = app.ctx.config.galleriesDir;
  for (const [folder, color] of [["2026-05-01 Family - Smith", { r: 200, g: 30, b: 30 }], ["2026-06-01 Wedding - Jones", { r: 30, g: 30, b: 200 }]] as const) {
    for (const name of ["a.jpg", "b.jpg"]) {
      const file = path.join(share, folder, "Gallery", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await sharp({ create: { width: 3000, height: 2000, channels: 3, background: color } }).jpeg().withExif({ IFD0: { Copyright: "secret-owner" } }).toFile(file);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(file, past, past);
    }
  }
  await app.inject({ method: "POST", url: "/api/studio/ingest/rescan", headers: { cookie: staff } });
  const folders = (await app.inject({ method: "GET", url: "/api/studio/ingest/folders", headers: { cookie: staff } })).json().folders;
  const ids: string[] = [];
  for (const f of folders) ids.push((await app.inject({ method: "POST", url: `/api/studio/ingest/folders/${f.id}/gallery`, payload: {}, headers: { cookie: staff } })).json().galleryId);
  await app.ctx.jobs.drain();
  return ids;
}

describe("site config", () => {
  it("drops unsafe links, bad colors and unknown keys", () => {
    const c = cleanConfig({ theme: { accent: "red;}</style>", bg: "#ABCDEF", headingFont: "nope" }, contact: { links: [{ label: "x", url: "javascript:alert(1)" }, { label: "ig", url: "https://example.com/a" }] }, siteUrl: "https://ex.com/path/", evil: 1 }, "Studio");
    expect(c.theme.accent).toBe(defaultSite("S").theme.accent);
    expect(c.theme.bg).toBe("#abcdef");
    expect(c.theme.headingFont).toBe(defaultSite("S").theme.headingFont);
    expect(c.contact.links).toEqual([{ label: "ig", url: "https://example.com/a" }]);
    expect(c.siteUrl).toBe("https://ex.com");
    expect(c).not.toHaveProperty("evil");
    expect(safeUrl("data:text/html,x")).toBe("");
  });

  it("escapes everything the owner types", () => {
    const config = defaultSite("Lumen");
    config.name = `<script>alert(1)</script>`;
    const home = config.pages.home.blocks[0]!;
    if (home.type === "hero") home.subheading = `"><img src=x onerror=alert(1)>`;
    const out = renderSite({ config, inquireUrl: "", logo: null, images: new Map(), share: null });
    const html = (out.files.find((f) => f.path === "index.html") as { text: string }).text;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("site builder", () => {
  it("serves a default site and keeps saved edits", async () => {
    const first = (await api("GET", "/")).json();
    expect(first.config.name).toBe("Lumen Photo");
    expect(first.templates.map((t: { id: string }) => t.id)).toEqual(["editorial", "studio", "clean"]);
    const config = { ...first.config, tagline: "Weddings in Maine" };
    const saved = (await api("PUT", "/", config)).json();
    expect(saved.config.tagline).toBe("Weddings in Maine");
    expect((await api("GET", "/")).json().config.tagline).toBe("Weddings in Maine");
  });

  it("is owner only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/site/" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/studio/site/export.zip" })).statusCode).toBe(401);
  });

  it("exports only the picked photos, as web copies with no metadata and no original file names", async () => {
    const [g1] = await makePhotos();
    const lib = (await api("GET", `/library/${g1}`)).json();
    expect(lib.photos).toHaveLength(2);
    const pick = lib.photos[0].id as string;
    const config = (await api("GET", "/")).json().config;
    config.pages.portfolio.blocks[0].photoIds = [pick];
    config.pages.home.blocks[0].photoId = pick;
    config.photos[pick] = { alt: "A red field", caption: "Smith family" };
    config.contact.email = "hi@example.com";
    config.siteUrl = "https://example.com";
    await api("PUT", "/", config);

    const report = (await api("GET", "/report")).json();
    expect(report.photos).toBe(1);

    const res = await api("GET", "/export.zip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    const body = res.rawPayload;
    const text = body.toString("latin1");
    for (const n of ["index.html", "portfolio/index.html", "sitemap.xml", "robots.txt", "_headers", "404.html"]) expect(text).toContain(n);
    const images = new Set([...text.matchAll(/images\/([0-9a-f]{10})-\d+\.webp/g)].map((m) => m[1]));
    expect(images.size).toBe(1); // one picked photo, however many sizes
    expect(text.match(/images\/(?![0-9a-f]{10}-\d+\.webp)/g)).toBeNull();
    expect(body.includes("a.jpg")).toBe(false);
    const preview = (await api("GET", "/preview/portfolio/")).body;
    expect(preview).toContain("Smith family"); // the caption the owner wrote
    expect(preview).not.toMatch(/a\.jpg|Gallery\/|2026-05-01/);
    expect(body.includes("secret-owner")).toBe(false);

    // The images on disk are re-encoded WebP with no EXIF, and are not larger than 2000 px.
    const cached = fs.readdirSync(path.join(app.ctx.config.cacheDir, "site")).filter((f) => f.endsWith(".webp"));
    expect(new Set(cached.map((f) => f.split("-")[0])).size).toBe(1);
    for (const f of cached) {
      const meta = await sharp(path.join(app.ctx.config.cacheDir, "site", f)).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.width).toBeLessThanOrEqual(2000);
    }
  });

  it("previews the same site", async () => {
    const home = await api("GET", "/preview/");
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.body).toContain("Lumen Photo");
    const css = home.body.match(/href="(assets\/site-[0-9a-f]{8}\.css)"/)![1]!;
    expect((await api("GET", `/preview/${css}`)).statusCode).toBe(200);
    expect((await api("GET", "/preview/portfolio/")).statusCode).toBe(200);
    expect((await api("GET", "/preview/missing.html")).statusCode).toBe(404);
  });

  it("warns when a button has nowhere to go", async () => {
    const report = (await api("GET", "/report")).json();
    expect(report.warnings.join(" ")).toMatch(/public address/);
  });

  it("lets an extension add a template, a page and a file, and falls back when it goes away", async () => {
    const { registerSiteTemplate, unregisterSiteTemplate, registerSiteExtension, unregisterSiteExtension } = await import("../src/site/registry.js");
    registerSiteTemplate({ id: "xt", name: "XT", description: "", header: "split", gallery: "grid", theme: defaultSite("x").theme, css: ".xt{}", extra: true });
    registerSiteExtension({ id: "xt", title: "XT", pages: () => [{ slug: "journal", title: "Journal", nav: "Journal", html: "<section class='blk'><div class='wrap'><h1>Hello</h1></div></section>" }, { slug: "journal/first", title: "First", html: "<p><a href='__BASE__journal/'>Back</a></p>" }], files: () => [{ path: "feed.xml", data: "<rss/>" }] });
    try {
      const config = (await api("GET", "/")).json().config;
      config.template = "xt";
      await api("PUT", "/", config);
      const home = (await api("GET", "/preview/")).body;
      expect(home).toContain('class="t-xt"');
      expect(home).toContain(">Journal</a>");
      expect((await api("GET", "/preview/journal/")).body).toContain("<h1>Hello</h1>");
      expect((await api("GET", "/preview/feed.xml")).body).toBe("<rss/>");
      const post = (await api("GET", "/preview/journal/first/")).body;
      expect(post).toContain('href="../../journal/"');
      expect(post).toContain('href="../../assets/site-');
    } finally {
      unregisterSiteTemplate("xt");
      unregisterSiteExtension("xt");
    }
    const after = (await api("GET", "/preview/")).body;
    expect(after).toContain('class="t-editorial"');
    expect(after).not.toContain(">Journal</a>");
    expect((await api("GET", "/report")).json().warnings.join(" ")).toMatch(/isn't available/);
  });
});
