import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let config: AppConfig;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-backup-"));
  config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(path.join(config.galleriesDir, "2026", "2026-05-01 Wedding - Ada", "Gallery"), { recursive: true });
  fs.mkdirSync(path.join(config.galleriesDir, "2026", "2026-05-01 Wedding - Ada", "Originals"), { recursive: true });
  fs.writeFileSync(path.join(config.galleriesDir, "2026", "2026-05-01 Wedding - Ada", "Gallery", "a.jpg"), "jpeg-bytes");
  fs.writeFileSync(path.join(config.galleriesDir, "2026", "2026-05-01 Wedding - Ada", "Originals", "a.nef"), "raw-bytes-raw");
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const req = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url: `/api/studio/backups${url}`, payload, headers: { cookie } });
const done = async () => {
  for (let i = 0; i < 100 && app.ctx.backups.status().running; i++) await new Promise((r) => setTimeout(r, 50));
};

describe("backups", () => {
  it("is owner only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/backups" })).statusCode).toBe(401);
  });

  it("starts with sensible defaults and saves changes", async () => {
    const first = (await req("GET", "")).json();
    expect(first.config).toEqual({ enabled: true, everyHours: 24, keep: 14, includeGalleries: false, includeOriginals: false });
    const bad = await req("PUT", "/config", { ...first.config, everyHours: 5 });
    expect(bad.statusCode).toBe(400);
    const ok = await req("PUT", "/config", { ...first.config, everyHours: 12, keep: 3, includeGalleries: true });
    expect(ok.json().config).toMatchObject({ everyHours: 12, keep: 3, includeGalleries: true, includeOriginals: false });
  });

  it("reports how much galleries and originals would add", async () => {
    const sizes = (await req("GET", "/sizes")).json();
    expect(sizes.galleries).toEqual({ files: 1, bytes: 10 });
    expect(sizes.originals).toEqual({ files: 1, bytes: 13 });
  });

  it("makes a database-only backup, lists it, downloads it, and deletes it", async () => {
    expect((await req("POST", "/run")).statusCode).toBe(202);
    await done();
    const list = (await req("GET", "")).json();
    expect(list.status.lastError).toBeNull();
    expect(list.files).toHaveLength(1);
    const file = list.files[0];
    expect(file).toMatchObject({ kind: "manual", includesGalleries: false, includesOriginals: false, files: 0 });
    const dl = await req("GET", `/files/${file.name}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/zip");
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(dl.rawPayload.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(dl.rawPayload.includes(Buffer.from("files/"))).toBe(false);
    expect((await req("DELETE", `/files/${file.name}`)).statusCode).toBe(200);
    expect((await req("GET", "")).json().files).toHaveLength(0);
  });

  it("includes galleries and originals only when chosen", async () => {
    await req("PUT", "/config", { enabled: true, everyHours: 24, keep: 14, includeGalleries: true, includeOriginals: false });
    await req("POST", "/run");
    await done();
    let file = (await req("GET", "")).json().files[0];
    let zip = (await req("GET", `/files/${file.name}`)).rawPayload;
    expect(file).toMatchObject({ includesGalleries: true, includesOriginals: false, files: 1 });
    expect(zip.includes(Buffer.from("a.jpg"))).toBe(true);
    expect(zip.includes(Buffer.from("a.nef"))).toBe(false);
    await req("DELETE", `/files/${file.name}`);

    await req("PUT", "/config", { enabled: true, everyHours: 24, keep: 14, includeGalleries: false, includeOriginals: true });
    await req("POST", "/run");
    await done();
    file = (await req("GET", "")).json().files[0];
    zip = (await req("GET", `/files/${file.name}`)).rawPayload;
    expect(zip.includes(Buffer.from("a.nef"))).toBe(true);
    expect(zip.includes(Buffer.from("a.jpg"))).toBe(false);
  });

  it("keeps only the newest scheduled backups and never serves other names", async () => {
    await req("PUT", "/config", { enabled: true, everyHours: 24, keep: 2, includeGalleries: false, includeOriginals: false });
    for (let i = 0; i < 3; i++) {
      await app.ctx.backups.run("scheduled");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(app.ctx.backups.list().filter((b) => b.kind === "scheduled")).toHaveLength(2);
    expect((await req("GET", "/files/..%2Fsecret.key")).statusCode).toBe(404);
    expect((await req("GET", "/files/openportrait.db")).statusCode).toBe(404);
  });
});
