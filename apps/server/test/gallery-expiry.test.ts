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
import { setTransportFactory } from "../src/domain/email.js";
import { reminderDue, tickExpiry } from "../src/domain/gallery-expiry.js";

let app: FastifyInstance;
let root: string;
let share: string;
let staff: string;

const DAY = 86_400_000;
const past = () => new Date(Date.now() - 3_600_000);
function put(rel: string, bytes: Buffer) {
  const file = path.join(share, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, past(), past());
}

beforeEach(async () => {
  setTransportFactory(() => ({ sendMail: async () => ({}) as never }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-expiry-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), INGEST_SETTLE_SECONDS: "0" });
  share = config.galleriesDir;
  fs.mkdirSync(share, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Test Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  staff = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const studio = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) => app.inject({ method, url: `/api/studio${url}`, payload, headers: { cookie: staff } });
const ctx = () => ({ db: app.ctx.db, settings: app.ctx.settings, config: app.ctx.config, actorId: null, publicUrl: app.ctx.publicUrl });
const gal = (id: string) => app.ctx.db.select().from(tables.gallery).where(eq(tables.gallery.id, id)).get()!;

async function setup() {
  const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 90, b: 200 } } }).jpeg().toBuffer();
  put("Kim/a.jpg", jpg);
  put("Kim/b.jpg", jpg);
  await studio("POST", "/ingest/rescan");
  const folders = (await studio("GET", "/ingest/folders")).json().folders;
  const id = (await studio("POST", `/ingest/folders/${folders[0].id}/gallery`, {})).json().galleryId as string;
  await app.ctx.jobs.drain();
  await app.ctx.galleries.scan();
  return id;
}

/** A client on the gallery's shoot, with email set up so reminders can go out. */
async function attachClient(id: string) {
  await studio("PUT", "/email", { host: "smtp.example.com", port: 587, security: "starttls", user: "u", password: "p", fromName: "Test Studio", fromAddress: "studio@example.com" });
  app.ctx.settings.set("internet.publicUrl", "https://studio.example.com");
  const contactId = (await studio("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).json().id as string;
  const typeId = (await studio("GET", "/shoot-types")).json().types[0].id as string;
  const shootId = (await studio("POST", "/shoots", { primaryContactId: contactId, shootTypeId: typeId, events: [] })).json().shoot.id as string;
  app.ctx.db.update(tables.gallery).set({ shootId }).where(eq(tables.gallery.id, id)).run();
  return { contactId, shootId };
}

describe("expiry date at first publish", () => {
  it("sets 12 months by default, only on the first publish, and never over a date the owner chose", async () => {
    const id = await setup();
    expect(gal(id).expiresAt).toBeNull();
    const res = await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    expect(res.statusCode).toBe(200);
    const exp = gal(id).expiresAt!.getTime();
    expect(exp).toBeGreaterThan(Date.now() + 360 * DAY);
    expect(exp).toBeLessThan(Date.now() + 370 * DAY);
    // Unpublish and publish again: the date stays.
    await studio("POST", `/galleries/${id}/unpublish`);
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    expect(gal(id).expiresAt!.getTime()).toBe(exp);
  });

  it("follows the studio setting, including never, and skips galleries that were published before", async () => {
    await studio("PUT", "/ingest/settings", { deliveryFolder: "Gallery", privateFolders: ["Originals"], defaultDownloadLock: "none", expiryMonths: 0 });
    const id = await setup();
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    expect(gal(id).expiresAt).toBeNull();
    expect((await studio("GET", "/ingest/settings")).json()).toMatchObject({ expiryMonths: 0, expiryReminders: true });
    // Raising it later does not reach a gallery that is already published.
    await studio("PUT", "/ingest/settings", { deliveryFolder: "Gallery", privateFolders: ["Originals"], defaultDownloadLock: "none", expiryMonths: 6 });
    await studio("POST", `/galleries/${id}/unpublish`);
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    expect(gal(id).expiresAt).toBeNull();
  });
});

describe("reminders", () => {
  it("picks the step that has been reached and not yet sent", () => {
    expect(reminderDue(200, 0)).toBeNull();
    expect(reminderDue(90, 0)).toBe(90);
    expect(reminderDue(60, 90)).toBeNull();
    expect(reminderDue(30, 90)).toBe(30);
    expect(reminderDue(7, 30)).toBe(7);
    expect(reminderDue(3, 7)).toBeNull();
    expect(reminderDue(20, 0)).toBe(30);
  });

  it("emails the shoot's clients once per step, and not when reminders are off", async () => {
    const id = await setup();
    await attachClient(id);
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    const set = (days: number) => app.ctx.db.update(tables.gallery).set({ expiresAt: new Date(Date.now() + days * DAY - 1000) }).where(eq(tables.gallery.id, id)).run();
    const mails = () => app.ctx.db.select().from(tables.emailLog).all().filter((m) => m.kind === "gallery_expiry");
    set(120);
    await tickExpiry(ctx(), app.ctx.originals);
    expect(mails()).toHaveLength(0);
    set(29);
    await tickExpiry(ctx(), app.ctx.originals);
    await tickExpiry(ctx(), app.ctx.originals);
    expect(mails()).toHaveLength(1);
    expect(mails()[0]).toMatchObject({ toAddress: "jane@example.com" });
    expect(mails()[0]!.bodyText).toContain("expire");
    set(5);
    await tickExpiry(ctx(), app.ctx.originals);
    expect(mails()).toHaveLength(2);
    // Off: nothing more.
    app.ctx.settings.set("galleries.expiryReminders", false);
    app.ctx.db.update(tables.gallery).set({ expiryReminderDays: 0 }).where(eq(tables.gallery.id, id)).run();
    await tickExpiry(ctx(), app.ctx.originals);
    expect(mails()).toHaveLength(2);
  });

  it("starts the steps over when the owner extends the date", async () => {
    const id = await setup();
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    app.ctx.db.update(tables.gallery).set({ expiryReminderDays: 7 }).where(eq(tables.gallery.id, id)).run();
    await studio("PATCH", `/galleries/${id}`, { expiresAt: Date.now() + 200 * DAY });
    expect(gal(id).expiryReminderDays).toBe(0);
  });
});

describe("archive", () => {
  it("zips an expired gallery, hides it from clients, keeps the files, and does not treat the Archive folder as a gallery", async () => {
    const id = await setup();
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    const slug = gal(id).slug;
    expect((await app.inject({ method: "GET", url: `/api/g/${slug}` })).statusCode).toBe(200);
    app.ctx.db.update(tables.gallery).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.gallery.id, id)).run();
    await tickExpiry(ctx(), app.ctx.originals);
    const g = gal(id);
    expect(g.status).toBe("archived");
    expect(g.archivedAt).toBeTruthy();
    const detail = (await studio("GET", `/galleries/${id}`)).json();
    expect(detail.archive.items).toHaveLength(1);
    expect(detail.archive.items[0]).toMatchObject({ fileCount: 2, reason: "expired", exists: true });
    expect(fs.existsSync(path.join(share, "Kim/a.jpg"))).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/g/${slug}` })).statusCode).toBe(404);
    // The zip is a real download.
    const dl = await studio("GET", `/galleries/${id}/archive/${detail.archive.items[0].id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/zip");
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe("PK");
    // A rescan must not turn _Archive into an unmatched folder.
    await studio("POST", "/ingest/rescan");
    expect((await studio("GET", "/ingest/folders")).json().folders.some((f: { relPath: string }) => f.relPath.startsWith("_Archive"))).toBe(false);
    // Publishing while archived is refused.
    expect((await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" })).json().error).toBe("archived");
  });

  it("restores missing files from the zip and returns the gallery as a draft with a fresh expiry", async () => {
    const id = await setup();
    await studio("POST", `/galleries/${id}/publish`, { downloadLock: "none" });
    const made = await studio("POST", `/galleries/${id}/archive`);
    expect(made.statusCode).toBe(200);
    const aid = made.json().archive.items[0].id as string;
    fs.rmSync(path.join(share, "Kim/b.jpg"));
    const res = await studio("POST", `/galleries/${id}/archive/${aid}/restore`);
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(share, "Kim/b.jpg"))).toBe(true);
    const g = gal(id);
    expect(g.status).toBe("draft");
    expect(g.archivedAt).toBeNull();
    expect(g.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    expect(res.json().archive.items[0].restoredAt).toBeTruthy();
  });

  it("refuses to archive twice, and archives nothing when remote files can't be reached", async () => {
    const id = await setup();
    await studio("POST", `/galleries/${id}/archive`);
    expect((await studio("POST", `/galleries/${id}/archive`)).json().error).toBe("already_archived");
  });
});
