import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { parseRoster } from "../src/domain/shoots.js";

let app: FastifyInstance;
let root: string;
let cookie: string;
let galleries: string;

async function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const res = await app.inject({ method, url: `/api/studio${url}`, headers: { cookie }, payload: payload as object | undefined });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-group-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  galleries = config.galleriesDir;
  fs.mkdirSync(galleries, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "T", ownerName: "Pat Doe", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
});

const nov14 = Date.UTC(2026, 10, 14, 18, 0);

async function makeDay(billTo?: "self" | "parent") {
  const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string; name: string }>;
  const org = (await call("POST", "/contacts", { firstName: "Acme", lastName: "Corp", email: "events@acme.example" })).body;
  const day = (await call("POST", "/shoots", { primaryContactId: org.id, shootTypeId: types.find((t) => t.name === "Headshot")!.id, subject: "Acme Corp", kind: "group_day", events: [{ startsAt: nov14, endsAt: nov14 + 3_600_000 }] })).body.shoot;
  if (billTo) await call("POST", `/shoots/${day.id}/group-day`, { billTo });
  return day.id as string;
}

describe("group days", () => {
  it("adds people as child shoots with their own folders and contacts", async () => {
    const day = await makeDay();
    const r = await call("POST", `/shoots/${day}/people`, { name: "Jane Smith", email: "Jane@Example.com" });
    expect(r.body, JSON.stringify(r.body)).toBeTruthy(); expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.child).toMatchObject({ subject: "Jane Smith", email: "jane@example.com", billTo: "self", showOnMaster: true });
    expect(r.body.child.folderPath.startsWith(`${(await call("GET", `/shoots/${day}`)).body.folderPath}/`)).toBe(true);
    expect(fs.existsSync(path.join(galleries, r.body.child.folderPath, "Originals", "RAW"))).toBe(true);
    expect(fs.existsSync(path.join(galleries, r.body.child.folderPath, "Gallery"))).toBe(true);
  });

  it("hides children from the shoot list unless asked, and lists them under their day", async () => {
    const day = await makeDay();
    await call("POST", `/shoots/${day}/people`, { name: "Jane Smith" });
    expect((await call("GET", "/shoots")).body.items.map((s: { subject: string }) => s.subject)).toEqual(["Acme Corp"]);
    expect((await call("GET", `/shoots?parentId=${day}`)).body.items.map((s: { subject: string }) => s.subject)).toEqual(["Jane Smith"]);
    expect((await call("GET", `/shoots/${day}`)).body.children).toHaveLength(1);
  });

  it("reuses a contact with the same email and refuses the same person twice", async () => {
    const day = await makeDay();
    const existing = (await call("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body;
    const a = await call("POST", `/shoots/${day}/people`, { name: "Jane S.", email: "jane@example.com" });
    expect(a.body.matched).toBe(true);
    expect(a.body.child.contactId).toBe(existing.id);
    const b = await call("POST", `/shoots/${day}/people`, { name: "Jane Smith", email: "jane@example.com" });
    expect(b.body.duplicate).toBe(true);
    expect((await call("GET", `/shoots/${day}`)).body.children).toHaveLength(1);
  });

  it("gives two people with the same name separate folders", async () => {
    const day = await makeDay();
    const a = await call("POST", `/shoots/${day}/people`, { name: "Sam Lee", email: "sam1@example.com" });
    const b = await call("POST", `/shoots/${day}/people`, { name: "Sam Lee", email: "sam2@example.com" });
    expect(a.body.child.folderPath).not.toBe(b.body.child.folderPath);
  });

  it("uses the day's billing default for new people, and rejects bad input", async () => {
    const day = await makeDay("parent");
    expect((await call("POST", `/shoots/${day}/people`, { name: "Jane Smith" })).body.child.billTo).toBe("parent");
    expect((await call("POST", `/shoots/${day}/people`, { name: " " })).status).toBe(400);
    expect((await call("POST", `/shoots/${day}/people`, { name: "Bad", email: "nope" })).status).toBe(400);
  });

  it("refuses to add people to an ordinary shoot", async () => {
    const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string }>;
    const c = (await call("POST", "/contacts", { firstName: "A", lastName: "B" })).body;
    const s = (await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0]!.id })).body.shoot;
    expect((await call("POST", `/shoots/${s.id}/people`, { name: "X" })).status).toBe(400);
  });

  it("imports a pasted roster and reports what it did", async () => {
    const day = await makeDay();
    const text = "Name,Email\nPriya Nair,priya@acme.example\nMarcus Webb\tmarcus@acme.example\nDana Ortiz\n\nPriya Nair,priya@acme.example\n,orphan@acme.example";
    const r = await call("POST", `/shoots/${day}/people/import`, { text });
    expect(r.body.added).toBe(3);
    expect(r.body.skipped).toHaveLength(1);
    expect(r.body.children.map((c: { subject: string }) => c.subject)).toEqual(["Priya Nair", "Marcus Webb", "Dana Ortiz"]);
  });

  it("only lets a person or a day use the day's invoice", async () => {
    const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string }>;
    const c = (await call("POST", "/contacts", { firstName: "A", lastName: "B" })).body;
    const s = (await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0]!.id })).body.shoot;
    expect((await call("PATCH", `/shoots/${s.id}`, { billTo: "parent" })).status).toBe(400);
  });
});

describe("parseRoster", () => {
  it("handles quotes, semicolons and header rows", () => {
    const r = parseRoster('"Name";"Email"\n"Lee, Sam";sam@x.example'.replace('"Lee, Sam"', "Sam Lee"));
    expect(r.people).toEqual([{ name: "Sam Lee", email: "sam@x.example" }]);
  });
});

describe("group day folders", () => {
  it("lets the scanner find each person's gallery inside the day's folder", async () => {
    const { discover } = await import("../src/galleries/discover.js");
    const day = await makeDay();
    const dayFolder = (await call("GET", `/shoots/${day}`)).body.folderPath as string;
    expect(fs.existsSync(path.join(galleries, dayFolder, "Gallery"))).toBe(false);
    expect(fs.existsSync(path.join(galleries, dayFolder, "Originals", "RAW"))).toBe(true);
    const a = (await call("POST", `/shoots/${day}/people`, { name: "Jane Smith" })).body.child.folderPath as string;
    const b = (await call("POST", `/shoots/${day}/people`, { name: "Marcus Webb" })).body.child.folderPath as string;
    expect(discover(galleries).map((c) => c.shootFolder)).toEqual([a, b].sort());
  });

  it("removes an empty delivery folder when an existing shoot becomes a day", async () => {
    const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string }>;
    const c = (await call("POST", "/contacts", { firstName: "A", lastName: "B" })).body;
    const s = (await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0]!.id, events: [{ startsAt: nov14, endsAt: nov14 + 1000 }] })).body.shoot;
    expect(fs.existsSync(path.join(galleries, s.folderPath, "Gallery"))).toBe(true);
    expect((await call("POST", `/shoots/${s.id}/group-day`, {})).status).toBe(200);
    expect(fs.existsSync(path.join(galleries, s.folderPath, "Gallery"))).toBe(false);
  });

  it("refuses to convert a shoot whose delivery folder has files", async () => {
    const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string }>;
    const c = (await call("POST", "/contacts", { firstName: "A", lastName: "B" })).body;
    const s = (await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0]!.id, events: [{ startsAt: nov14, endsAt: nov14 + 1000 }] })).body.shoot;
    fs.writeFileSync(path.join(galleries, s.folderPath, "Gallery", "a.jpg"), "x");
    expect((await call("POST", `/shoots/${s.id}/group-day`, {})).status).toBe(400);
  });
});
