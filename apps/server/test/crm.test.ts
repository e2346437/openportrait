import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let root: string;
let cookie: string;
let galleries: string;

const owner = { studioName: "Test Studio", ownerName: "Pat Doe", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" };

async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const res = await app.inject({ method, url: `/api/studio${url}`, headers: { cookie }, payload: payload as object | undefined });
  return { status: res.statusCode, body: res.body ? (res.headers["content-type"]?.toString().includes("json") ? res.json() : res.body) : null };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-crm-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  galleries = config.galleriesDir;
  fs.mkdirSync(galleries, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
});

const nov14 = Date.UTC(2026, 10, 14, 18, 0); // 12:00 in Chicago, still the 14th everywhere
const hour = 3_600_000;

async function typeId(name: string) {
  const { body } = await call("GET", "/shoot-types");
  return body.types.find((t: { name: string }) => t.name === name).id as string;
}

describe("access", () => {
  it("needs a signed-in user", async () => {
    for (const url of ["/contacts", "/leads", "/shoots", "/shoot-types", "/folders"]) {
      expect((await app.inject(`/api/studio${url}`)).statusCode).toBe(401);
    }
  });

  it("starts a new studio with lead stages and shoot types", async () => {
    const stages = (await call("GET", "/lead-stages")).body.stages.map((s: { name: string }) => s.name);
    expect(stages).toEqual(["New inquiry", "In conversation", "Quote sent", "Booked", "Lost"]);
    const types = (await call("GET", "/shoot-types")).body.types.map((t: { name: string }) => t.name);
    expect(types).toContain("Headshot");
  });
});

describe("contacts", () => {
  it("creates, finds, tags and annotates a contact", async () => {
    const created = await call("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "Jane@Example.com", phone: "555-0100" });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe("jane@example.com");
    await call("POST", "/contacts", { firstName: "Joe", lastName: "Jones" });

    expect((await call("GET", "/contacts?q=smith%20jane")).body.items.map((c: { name: string }) => c.name)).toEqual(["Jane Smith"]);
    expect((await call("GET", "/contacts?q=555-01")).body.total).toBe(1);
    expect((await call("GET", "/contacts?q=%25")).body.total).toBe(0); // a literal percent sign, not a wildcard

    const tags = await call("PUT", `/contacts/${created.body.id}/tags`, { tags: ["Wedding", "wedding", "VIP"] });
    expect(tags.body.tags).toEqual(["VIP", "Wedding"]);
    expect((await call("GET", "/contacts?tag=vip")).body.items).toHaveLength(1);

    await call("POST", `/contacts/${created.body.id}/notes`, { body: "Prefers evenings." });
    const detail = (await call("GET", `/contacts/${created.body.id}`)).body;
    expect(detail.timeline.map((t: { type: string }) => t.type).sort()).toEqual(["activity", "note"]);
    expect((await call("POST", `/contacts/${created.body.id}/notes`, { body: "  " })).status).toBe(400);
  });

  it("rejects an empty contact and a bad email", async () => {
    expect((await call("POST", "/contacts", {})).body.message).toMatch(/name, company or email/);
    const bad = await call("POST", "/contacts", { firstName: "A", email: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("Enter a valid email address.");
  });

  it("archives and restores", async () => {
    const c = (await call("POST", "/contacts", { firstName: "Gone" })).body;
    await call("POST", `/contacts/${c.id}/archive`);
    expect((await call("GET", "/contacts")).body.total).toBe(0);
    expect((await call("GET", "/contacts?archived=true")).body.total).toBe(1);
    await call("POST", `/contacts/${c.id}/restore`);
    expect((await call("GET", "/contacts")).body.total).toBe(1);
  });
});

describe("leads", () => {
  it("reuses a contact with the same email", async () => {
    const first = await call("POST", "/leads", { contact: { firstName: "Dana", email: "dana@example.com" }, source: "Contact form" });
    const second = await call("POST", "/leads", { contact: { firstName: "Dana R", email: "DANA@example.com" } });
    expect(second.body.reusedContact).toBe(true);
    expect(second.body.lead.contactId).toBe(first.body.lead.contactId);
    expect((await call("GET", "/contacts")).body.total).toBe(1);
  });

  it("moves through stages, but winning needs a booking", async () => {
    const lead = (await call("POST", "/leads", { contact: { firstName: "Sam" } })).body.lead;
    const stages = (await call("GET", "/lead-stages")).body.stages;
    const by = (n: string) => stages.find((s: { name: string }) => s.name === n).id;
    expect((await call("POST", `/leads/${lead.id}/move`, { stageId: by("Quote sent") })).body.stage.name).toBe("Quote sent");
    const win = await call("POST", `/leads/${lead.id}/move`, { stageId: by("Booked") });
    expect(win.status).toBe(400);
    expect(win.body.error).toBe("use_convert");
    const lost = await call("POST", `/leads/${lead.id}/lose`, { reason: "Went with a friend" });
    expect(lost.body.stage.name).toBe("Lost");
    expect(lost.body.lostReason).toBe("Went with a friend");
    expect((await call("POST", `/leads/${lead.id}/move`, { stageId: by("New inquiry") })).body.closedAt).toBeNull();
  });

  it("books a lead into a shoot and creates its folders", async () => {
    const lead = (await call("POST", "/leads", { contact: { firstName: "Jane", lastName: "Smith", email: "jane@example.com" }, shootTypeId: await typeId("Headshot") })).body.lead;
    const res = await call("POST", `/leads/${lead.id}/convert`, { events: [{ startsAt: nov14, endsAt: nov14 + hour, location: "Riverside Park" }] });
    expect(res.status).toBe(200);
    expect(res.body.folderError).toBeNull();
    expect(res.body.shoot.folderPath).toBe("2026/2026-11-14 Headshot - Jane Smith");
    for (const sub of ["Originals/RAW", "Gallery"]) expect(fs.existsSync(path.join(galleries, res.body.shoot.folderPath, sub))).toBe(true);
    expect(res.body.lead.stage.name).toBe("Booked");
    expect((await call("POST", `/leads/${lead.id}/convert`, {})).body.error).toBe("converted");
  });
});

describe("shoots and folders", () => {
  async function contactId(first = "Jane", last = "Smith") {
    return (await call("POST", "/contacts", { firstName: first, lastName: last })).body.id as string;
  }

  it("waits for a date before creating the folder", async () => {
    const shoot = (await call("POST", "/shoots", { primaryContactId: await contactId(), shootTypeId: await typeId("Portrait") })).body;
    expect(shoot.shoot.folderPath).toBeNull();
    expect(shoot.shoot.subject).toBe("Jane Smith");
    const added = await call("POST", `/shoots/${shoot.shoot.id}/events`, { startsAt: nov14, endsAt: nov14 + hour });
    expect(added.body.shoot.folderPath).toBe("2026/2026-11-14 Portrait - Jane Smith");
  });

  it("gives two shoots with the same name different folders", async () => {
    const c = await contactId();
    const t = await typeId("Headshot");
    const body = { primaryContactId: c, shootTypeId: t, events: [{ startsAt: nov14, endsAt: nov14 + hour }] };
    const a = (await call("POST", "/shoots", body)).body.shoot;
    const b = (await call("POST", "/shoots", body)).body.shoot;
    expect(a.folderPath).toBe("2026/2026-11-14 Headshot - Jane Smith");
    expect(b.folderPath).toBe("2026/2026-11-14 Headshot - Jane Smith (2)");
  });

  it("keeps the folder when the shoot is renamed, until asked to rename it", async () => {
    const created = (await call("POST", "/shoots", { primaryContactId: await contactId(), shootTypeId: await typeId("Headshot"), subject: "Jane Smith", events: [{ startsAt: nov14, endsAt: nov14 + hour }] })).body.shoot;
    fs.writeFileSync(path.join(galleries, created.folderPath, "Gallery", "a.jpg"), "x");
    const edited = (await call("PATCH", `/shoots/${created.id}`, { subject: "Jane & John Smith" })).body;
    expect(edited.folderPath).toBe(created.folderPath);
    const renamed = (await call("POST", `/shoots/${created.id}/rename-folder`)).body;
    expect(renamed.folderPath).toBe("2026/2026-11-14 Headshot - Jane & John Smith");
    expect(fs.existsSync(path.join(galleries, renamed.folderPath, "Gallery", "a.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(galleries, created.folderPath))).toBe(false);
  });

  it("saves the shoot and explains it when the share can't be written", async () => {
    fs.rmSync(galleries, { recursive: true });
    fs.writeFileSync(galleries, "a file, not a folder");
    const res = await call("POST", "/shoots", { primaryContactId: await contactId(), shootTypeId: await typeId("Headshot"), events: [{ startsAt: nov14, endsAt: nov14 + hour }] });
    expect(res.status).toBe(201);
    expect(res.body.shoot.folderPath).toBeNull();
    expect(res.body.folderError).toEqual(expect.any(String));
  });

  it("lists upcoming shoots first and filters by status", async () => {
    const c = await contactId();
    const t = await typeId("Family");
    const future = Date.now() + 30 * 24 * hour;
    const soon = (await call("POST", "/shoots", { primaryContactId: c, shootTypeId: t, subject: "Soon", events: [{ startsAt: future, endsAt: future + hour }] })).body.shoot;
    await call("POST", "/shoots", { primaryContactId: c, shootTypeId: t, subject: "Past", events: [{ startsAt: nov14 - 400 * 24 * hour, endsAt: nov14 - 400 * 24 * hour + hour }] });
    expect((await call("GET", "/shoots?when=upcoming")).body.items.map((s: { subject: string }) => s.subject)).toEqual(["Soon"]);
    await call("PATCH", `/shoots/${soon.id}`, { status: "cancelled" });
    expect((await call("GET", "/shoots?status=active")).body.items.map((s: { subject: string }) => s.subject)).toEqual(["Past"]);
  });

  it("rejects an event that ends before it starts", async () => {
    const s = (await call("POST", "/shoots", { primaryContactId: await contactId(), shootTypeId: await typeId("Family") })).body.shoot;
    const bad = await call("POST", `/shoots/${s.id}/events`, { startsAt: nov14, endsAt: nov14 - hour });
    expect(bad.status).toBe(400);
  });
});

describe("settings", () => {
  it("validates the folder pattern and previews it", async () => {
    expect((await call("GET", "/folders")).body.example).toBe("2026/2026-11-14 Headshot - Jane Smith");
    expect((await call("PUT", "/folders", { pattern: "{date} {typ} {subject}", rawSubdir: "Originals/RAW", deliverySubdir: "Gallery" })).body.message).toMatch(/Unknown token: \{typ\}/);
    expect((await call("PUT", "/folders", { pattern: "{date} {type}", rawSubdir: "RAW", deliverySubdir: "Gallery" })).body.message).toMatch(/\{subject\} or \{client\}/);
    expect((await call("PUT", "/folders", { pattern: "{year}/{date} {type} - {subject}", rawSubdir: "Gallery/RAW", deliverySubdir: "Gallery" })).body.message).toMatch(/separate/);
    const ok = await call("PUT", "/folders", { pattern: "{date} - {subject} ({type})", rawSubdir: "Originals/RAW", deliverySubdir: "Edited" });
    expect(ok.body.example).toBe("2026-11-14 - Jane Smith (Headshot)");
    expect((await call("POST", "/folders/preview", { pattern: "{client}/{location}" })).body.example).toBe("Jane Smith/Riverside Park");
  });

  it("archives shoot types that are in use and keeps one", async () => {
    const family = await typeId("Family");
    const c = (await call("POST", "/contacts", { firstName: "A" })).body.id;
    await call("POST", "/shoots", { primaryContactId: c, shootTypeId: family });
    expect((await call("DELETE", `/shoot-types/${family}`)).body.result).toBe("archived");
    const unused = (await call("POST", "/shoot-types", { name: "Boudoir" })).body;
    expect((await call("DELETE", `/shoot-types/${unused.id}`)).body.result).toBe("deleted");
    expect((await call("POST", "/shoot-types", { name: "headshot" })).status).toBe(400);
  });

  it("protects Booked and Lost, and empty open stages can go", async () => {
    const stages = (await call("GET", "/lead-stages")).body.stages;
    const booked = stages.find((s: { name: string }) => s.name === "Booked");
    const removed = await call("DELETE", `/lead-stages/${booked.id}`);
    expect(removed.status).toBe(400);
    const extra = (await call("POST", "/lead-stages", { name: "Waiting on deposit" })).body;
    expect((await call("GET", "/lead-stages")).body.stages.map((s: { name: string }) => s.name)).toEqual(["New inquiry", "In conversation", "Quote sent", "Waiting on deposit", "Booked", "Lost"]);
    expect((await call("DELETE", `/lead-stages/${extra.id}`)).status).toBe(204);
  });
});
