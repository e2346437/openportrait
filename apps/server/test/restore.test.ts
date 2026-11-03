import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "@openportrait/config";
import { tables } from "@openportrait/db";
import { buildApp } from "../src/app.js";
import { safeRelative } from "../src/restore.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let config: AppConfig;
const gal = () => path.join(config.galleriesDir, "2026", "2026-05-01 Wedding - Ada");

/** A minimal stored-only zip writer that keeps entry names exactly as given, so hostile names can be tested. */
function zipOf(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Reads a stored archive made by the app back into its entries. */
function dbBytes(): Buffer {
  const file = path.join(root, "snap.db");
  fs.rmSync(file, { force: true });
  app.ctx.db.$client.exec(`vacuum into '${file}'`);
  return fs.readFileSync(file);
}
const manifest = (extra: object = {}) =>
  JSON.stringify({ app: "openportrait", version: 1, createdAt: "2026-05-01T00:00:00.000Z", trigger: "manual", includesGalleries: true, includesOriginals: false, files: 0, fileBytes: 0, ...extra });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-restore-"));
  config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(path.join(gal(), "Gallery"), { recursive: true });
  fs.writeFileSync(path.join(gal(), "Gallery", "a.jpg"), "jpeg-bytes");
  fs.writeFileSync(path.join(gal(), "Gallery", "b.jpg"), "second-photo");
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  app.ctx.restore.restart = vi.fn();
});
afterEach(async () => {
  await app.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url: `/api/studio/backups${url}`, payload, headers: { cookie } });
const upload = (body: Buffer, headers: Record<string, string> = { cookie }) =>
  app.inject({ method: "POST", url: "/api/studio/backups/restore/upload", payload: body, headers: { "content-type": "application/octet-stream", ...headers } });
const studioName = (a: FastifyInstance) => a.ctx.settings.get("studio.name");
async function reopen() {
  await app.close();
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  app.ctx.restore.restart = vi.fn();
  await app.ctx.restore.filesDone;
}
const stageName = async (name: string) => req("POST", "/restore/from-backup", { name });

describe("restore", () => {
  it("is owner only, including the upload before any bytes are read", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/backups/restore" })).statusCode).toBe(401);
    expect((await upload(Buffer.from("PK"), {})).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/studio/backups/restore/confirm", payload: { confirm: true } })).statusCode).toBe(401);
  });

  it("restores the database and the photos from a listed backup after a restart, and never overwrites", async () => {
    app.ctx.settings.set("backup.includeGalleries", true);
    const made = await app.ctx.backups.run("manual");
    // The studio changes after the backup: a new name, one photo lost, one photo edited.
    app.ctx.settings.set("studio.name", "Changed Name");
    fs.rmSync(path.join(gal(), "Gallery", "a.jpg"));
    fs.writeFileSync(path.join(gal(), "Gallery", "b.jpg"), "edited-later");

    const staged = await stageName(made.name);
    expect(staged.statusCode).toBe(200);
    expect(staged.json().plan).toMatchObject({ phase: "staged", includesGalleries: true, files: 2, kind: "zip" });
    // Nothing changes until it is confirmed and the app restarts.
    expect(studioName(app)).toBe("Changed Name");

    const confirmed = await req("POST", "/restore/confirm", { confirm: true, withFiles: true });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().plan.safetyBackup).toMatch(/^openportrait-manual-.*\.zip$/);
    expect(studioName(app)).toBe("Changed Name");
    expect((await req("POST", "/restore/restart")).statusCode).toBe(202);
    expect(app.ctx.restore.restart).toHaveBeenCalled();

    await reopen();
    expect(studioName(app)).toBe("Lumen Studio");
    expect(fs.readFileSync(path.join(gal(), "Gallery", "a.jpg"), "utf8")).toBe("jpeg-bytes");
    expect(fs.readFileSync(path.join(gal(), "Gallery", "b.jpg"), "utf8")).toBe("edited-later");
    const state = app.ctx.restore.state();
    expect(state.plan).toBeNull();
    expect(state.result).toMatchObject({ ok: true, filesRestored: 1, filesSkipped: 1, filesFailed: 0 });
    expect(fs.existsSync(path.join(config.configDir, "openportrait.db.before-restore"))).toBe(true);
    expect(fs.existsSync(path.join(config.configDir, "restore-pending"))).toBe(false);
    app.ctx.restore.dismissResult();
    expect(app.ctx.restore.state().result).toBeNull();
  });

  it("can restore the database only", async () => {
    app.ctx.settings.set("backup.includeGalleries", true);
    const made = await app.ctx.backups.run("manual");
    app.ctx.settings.set("studio.name", "Changed Name");
    fs.rmSync(path.join(gal(), "Gallery", "a.jpg"));
    await stageName(made.name);
    await req("POST", "/restore/confirm", { confirm: true, withFiles: false });
    await reopen();
    expect(studioName(app)).toBe("Lumen Studio");
    expect(fs.existsSync(path.join(gal(), "Gallery", "a.jpg"))).toBe(false);
  });

  it("restores from an uploaded archive and from an older database-only snapshot", async () => {
    const made = await app.ctx.backups.run("manual");
    const bytes = fs.readFileSync(app.ctx.backups.pathOf(made.name)!);
    app.ctx.settings.set("studio.name", "Changed Name");
    const up = await upload(bytes, { cookie, "x-file-name": encodeURIComponent("my backup.zip") });
    expect(up.statusCode).toBe(200);
    expect(up.json().plan).toMatchObject({ source: "my backup.zip", phase: "staged" });
    expect((await req("DELETE", "/restore")).json().ok).toBe(true);
    expect(app.ctx.restore.state().plan).toBeNull();

    const legacy = await upload(dbBytes());
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().plan).toMatchObject({ kind: "db", files: 0 });
    await req("POST", "/restore/confirm", { confirm: true });
    await reopen();
    expect(studioName(app)).toBe("Changed Name");
    expect(app.ctx.restore.state().result).toMatchObject({ ok: true });
  });

  it("takes a safety backup of the current data before confirming", async () => {
    const made = await app.ctx.backups.run("manual");
    await stageName(made.name);
    const before = app.ctx.backups.list().length;
    const res = await req("POST", "/restore/confirm", { confirm: true });
    expect(app.ctx.backups.list()).toHaveLength(before + 1);
    expect(app.ctx.backups.list().some((b) => b.name === res.json().plan.safetyBackup)).toBe(true);
  });

  it("refuses to confirm without an explicit yes, or with nothing staged, or to restart unconfirmed", async () => {
    expect((await req("POST", "/restore/confirm", { confirm: true })).statusCode).toBe(400);
    const made = await app.ctx.backups.run("manual");
    await stageName(made.name);
    expect((await req("POST", "/restore/confirm", {})).statusCode).toBe(400);
    expect((await req("POST", "/restore/restart")).statusCode).toBe(409);
  });

  describe("refuses a bad archive and leaves everything untouched", () => {
    const expectRefused = async (body: Buffer, text: RegExp) => {
      const res = await upload(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(text);
      expect(app.ctx.restore.state().plan).toBeNull();
      expect(fs.existsSync(path.join(config.configDir, "restore-pending"))).toBe(false);
      expect(studioName(app)).toBe("Lumen Studio");
    };

    it("not a backup at all", async () => {
      await expectRefused(Buffer.from("this is just some text, not a backup file"), /isn't an OpenPortrait backup/);
      await expectRefused(Buffer.from("tiny"), /isn't an OpenPortrait backup/);
    });

    it("a zip with no database or manifest", async () => {
      await expectRefused(zipOf([{ name: "hello.txt", data: "hi" }]), /holds files in places/);
      await expectRefused(zipOf([{ name: "manifest.json", data: manifest() }]), /no database/);
    });

    it("a database that was changed after the archive was made (tampered)", async () => {
      const db = dbBytes();
      const archive = zipOf([
        { name: "openportrait.db", data: db },
        { name: "manifest.json", data: manifest() },
      ]);
      // Flip a byte inside the stored database; the archive's recorded checksum no longer matches.
      const at = archive.indexOf(db.subarray(100, 140));
      archive[at + 5] ^= 0xff;
      await expectRefused(archive, /changed or damaged/);
    });

    it("a damaged database", async () => {
      await expectRefused(
        zipOf([
          { name: "openportrait.db", data: Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4000, 7)]) },
          { name: "manifest.json", data: manifest() },
        ]),
        /damaged|readable|isn't an OpenPortrait database/,
      );
    });

    it("a manifest from something else", async () => {
      await expectRefused(
        zipOf([
          { name: "openportrait.db", data: dbBytes() },
          { name: "manifest.json", data: JSON.stringify({ app: "other", version: 1 }) },
        ]),
        /not made by this version/,
      );
    });

    it("a database from a newer version of the app", async () => {
      const file = path.join(root, "newer.db");
      fs.writeFileSync(file, dbBytes());
      const Db = app.ctx.db.$client.constructor as new (f: string) => { exec(s: string): void; close(): void };
      const c = new Db(file);
      c.exec("insert into __drizzle_migrations (hash, created_at) values ('x', 99999999999999)");
      c.close();
      await expectRefused(
        zipOf([
          { name: "openportrait.db", data: fs.readFileSync(file) },
          { name: "manifest.json", data: manifest() },
        ]),
        /newer version/,
      );
    });

    it.each(["files/../evil.txt", "files/a/../../evil.txt", "/etc/evil", "files//x", "files/a\\..\\evil", "files/.hidden/x", "../evil.txt", "files/C:/evil"])("path traversal: %s", async (name) => {
      await expectRefused(
        zipOf([
          { name: "openportrait.db", data: dbBytes() },
          { name: "manifest.json", data: manifest() },
          { name, data: "evil" },
        ]),
        /places a backup never uses|isn't a readable|damaged/,
      );
      expect(fs.existsSync(path.join(root, "evil.txt"))).toBe(false);
    });
  });

  it("only accepts plain relative paths under files/", () => {
    expect(safeRelative("files/2026/a.jpg")).toBe("2026/a.jpg");
    for (const bad of ["files/", "files/../x", "files/./x", "files/a//b", "/files/x", "x/files/a", "files/a\\b", "files/.x", "files/a/.b", "files/D:/x", "files/a\0b"]) expect(safeRelative(bad)).toBeNull();
  });

  it("counts a changed photo as failed instead of writing it", async () => {
    const photo = Buffer.from("original-photo-bytes");
    const archive = zipOf([
      { name: "openportrait.db", data: dbBytes() },
      { name: "manifest.json", data: manifest({ files: 2 }) },
      { name: "files/2026/good.jpg", data: "good-bytes" },
      { name: "files/2026/bad.jpg", data: photo },
    ]);
    archive[archive.indexOf(photo) + 3] ^= 0xff;
    expect((await upload(archive)).statusCode).toBe(200);
    await req("POST", "/restore/confirm", { confirm: true });
    await reopen();
    const result = app.ctx.restore.state().result!;
    expect(result).toMatchObject({ ok: false, filesRestored: 1, filesFailed: 1 });
    expect(result.problems.join(" ")).toMatch(/bad\.jpg/);
    expect(fs.readFileSync(path.join(config.galleriesDir, "2026", "good.jpg"), "utf8")).toBe("good-bytes");
    expect(fs.existsSync(path.join(config.galleriesDir, "2026", "bad.jpg"))).toBe(false);
    expect(fs.readdirSync(path.join(config.galleriesDir, "2026")).some((n) => n.endsWith(".partial"))).toBe(false);
  });

  it("does not follow a link out of the galleries folder", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(config.galleriesDir, "linked"));
    const archive = zipOf([
      { name: "openportrait.db", data: dbBytes() },
      { name: "manifest.json", data: manifest({ files: 1 }) },
      { name: "files/linked/x.jpg", data: "x" },
    ]);
    await upload(archive);
    await req("POST", "/restore/confirm", { confirm: true });
    await reopen();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(app.ctx.restore.state().result).toMatchObject({ filesFailed: 1, filesRestored: 0 });
  });

  it("cancels cleanly if the staged database is swapped out before the restart", async () => {
    const made = await app.ctx.backups.run("manual");
    app.ctx.settings.set("studio.name", "Changed Name");
    await stageName(made.name);
    await req("POST", "/restore/confirm", { confirm: true });
    fs.appendFileSync(path.join(config.configDir, "restore-pending", "openportrait.db"), "tamper");
    await reopen();
    expect(studioName(app)).toBe("Changed Name");
    expect(app.ctx.restore.state().result).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing was changed/) });
    expect(app.ctx.restore.state().plan).toBeNull();
    void tables;
  });
});
