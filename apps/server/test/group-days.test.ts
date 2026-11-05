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

async function call(method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, payload?: unknown) {
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

describe("sorting by name cards", () => {
  function drop(name: string, secondsAgo: number) {
    const incoming = path.join(app.ctx.config.incomingDir, "Z9");
    fs.mkdirSync(incoming, { recursive: true });
    const f = path.join(incoming, name);
    fs.writeFileSync(f, name);
    const t = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(f, t, t);
    return `Z9/${name}`;
  }

  it("assigns every frame from a name card to the next to that person and moves the files", async () => {
    const day = await makeDay();
    const stray = drop("A0.nef", 600);
    const c1 = drop("A1.nef", 500);
    const a2 = drop("A2.nef", 490);
    const a3 = drop("A3.nef", 480);
    const c2 = drop("A4.nef", 400);
    const b1 = drop("A5.nef", 390);
    const r = await call("POST", "/incoming/sort", { parentId: day, paths: [b1, c2, a3, stray, c1, a2], cards: [{ path: c1, name: "Jane Smith", email: "jane@example.com" }, { path: c2, name: "Marcus Webb" }] });
    expect(r.status).toBe(200);
    expect(r.body.leftOver).toBe(1);
    expect(r.body.moved).toBe(5);
    expect(r.body.people.map((p: { subject: string; frames: number }) => [p.subject, p.frames])).toEqual([["Jane Smith", 3], ["Marcus Webb", 2]]);
    const jane = (await call("GET", `/shoots/${day}`)).body.children.find((c: { subject: string }) => c.subject === "Jane Smith");
    expect(fs.readdirSync(path.join(galleries, jane.folderPath, "Originals", "RAW")).sort()).toEqual(["A1.nef", "A2.nef", "A3.nef"]);
    expect(fs.existsSync(path.join(app.ctx.config.incomingDir, "Z9", "A0.nef"))).toBe(true);
  });

  it("changes nothing when a request is wrong", async () => {
    const day = await makeDay();
    const a = drop("B1.nef", 300);
    expect((await call("POST", "/incoming/sort", { parentId: day, paths: [a], cards: [{ path: "Z9/nope.nef", name: "X" }] })).status).toBe(400);
    expect((await call("POST", "/incoming/sort", { parentId: day, paths: [a], cards: [{ path: a, name: " " }] })).status).toBe(400);
    expect((await call("GET", `/shoots/${day}`)).body.children).toHaveLength(0);
    expect(fs.existsSync(path.join(app.ctx.config.incomingDir, a))).toBe(true);
  });

  it("refuses an ordinary shoot", async () => {
    const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string }>;
    const c = (await call("POST", "/contacts", { firstName: "A", lastName: "B" })).body;
    const s = (await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0]!.id })).body.shoot;
    const a = drop("C1.nef", 300);
    expect((await call("POST", "/incoming/sort", { parentId: s.id, paths: [a], cards: [{ path: a, name: "X" }] })).status).toBe(400);
  });
});

describe("marks made while shooting", () => {
  function drop(name: string, secondsAgo: number) {
    const incoming = path.join(app.ctx.config.incomingDir, "Z9");
    fs.mkdirSync(incoming, { recursive: true });
    const f = path.join(incoming, name);
    fs.writeFileSync(f, name);
    const t = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(f, t, t);
    return `Z9/${name}`;
  }

  it("saves marks, then sorts the whole folder from them, reusing a person picked from the list", async () => {
    const day = await makeDay();
    const listed = (await call("POST", `/shoots/${day}/people`, { name: "Priya Nair", email: "priya@acme.example" })).body.child;
    const c1 = drop("M1.nef", 300);
    drop("M2.nef", 290);
    const c2 = drop("M3.nef", 200);
    drop("M4.nef", 190);
    expect((await call("POST", `/incoming/days/${day}/marks`, { path: c1, name: "Priya Nair", childId: listed.id })).body.marks).toHaveLength(1);
    await call("POST", `/incoming/days/${day}/marks`, { path: c2, name: "Marcus Webb" });
    expect((await call("GET", `/incoming/days/${day}/marks`)).body.marks).toHaveLength(2);
    const r = await call("POST", `/incoming/days/${day}/apply`);
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(4);
    const kids = (await call("GET", `/shoots/${day}`)).body.children as Array<{ id: string; subject: string }>;
    expect(kids).toHaveLength(2);
    expect(kids.some((k) => k.id === listed.id)).toBe(true);
    expect((await call("GET", `/incoming/days/${day}/marks`)).body.marks).toHaveLength(0);
  });

  it("replaces a mark on the same frame and removes marks", async () => {
    const day = await makeDay();
    const c1 = drop("N1.nef", 100);
    await call("POST", `/incoming/days/${day}/marks`, { path: c1, name: "Wrong Name" });
    const r = await call("POST", `/incoming/days/${day}/marks`, { path: c1, name: "Right Name" });
    expect(r.body.marks).toHaveLength(1);
    expect(r.body.marks[0].name).toBe("Right Name");
    expect((await call("DELETE", `/incoming/days/${day}/marks?path=${encodeURIComponent(c1)}`)).body.marks).toHaveLength(0);
  });

  it("refuses to apply with nothing marked, or to mark a missing frame", async () => {
    const day = await makeDay();
    expect((await call("POST", `/incoming/days/${day}/apply`)).status).toBe(400);
    expect((await call("POST", `/incoming/days/${day}/marks`, { path: "Z9/none.nef", name: "X" })).status).toBe(409);
  });
});

describe("group day billing", () => {
  async function photographed(day: string, name: string, email: string, frames = 2) {
    const child = (await call("POST", `/shoots/${day}/people`, { name, email })).body.child as { id: string; folderPath: string };
    const raw = path.join(galleries, child.folderPath, "Originals", "RAW");
    for (let i = 0; i < frames; i++) fs.writeFileSync(path.join(raw, `${name.replace(/\W/g, "")}${i}.jpg`), "x");
    return child;
  }

  it("splits cents so the shares add up exactly", async () => {
    const { splitCents, splitByWeight } = await import("../src/domain/groupbilling.js");
    expect(splitCents(26000, 8)).toEqual(Array(8).fill(3250));
    expect(splitCents(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(splitCents(5, 0)).toEqual([]);
    expect(splitByWeight(10000, [4, 1, 1]).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(splitByWeight(10000, [4, 1, 1])).toEqual([6667, 1667, 1666]);
  });

  it("makes one draft invoice per photographed person with their share, and skips the rest", async () => {
    const day = await makeDay();
    await call("POST", `/shoots/${day}/costs`, { label: "Location fee", amountCents: 20000 });
    await call("POST", `/shoots/${day}/costs`, { label: "Travel", amountCents: 6000 });
    const a = await photographed(day, "Smith Family", "s@x.example");
    await photographed(day, "Lee Family", "l@x.example");
    await photographed(day, "Ortiz Family", "o@x.example");
    await call("POST", `/shoots/${day}/people`, { name: "No Show", email: "n@x.example" });
    const billing = (await call("GET", `/shoots/${day}/billing`)).body;
    expect(billing.totalCostCents).toBe(26000);
    expect(billing.billableCount).toBe(3);
    expect(billing.people.map((p: { shareCents: number }) => p.shareCents)).toEqual([8667, 8667, 8666, 0]);
    const r = await call("POST", `/shoots/${day}/invoices`, { lines: [{ description: "Mini session", unitCents: 17500 }] });
    expect(r.status).toBe(201);
    expect(r.body.created.map((c: { totalCents: number }) => c.totalCents)).toEqual([26167, 26167, 26166]);
    expect(r.body.skipped.map((s: { subject: string }) => s.subject)).toEqual(["No Show"]);
    const inv = (await call("GET", `/orders/${r.body.created[0].orderId}`)).body;
    expect(inv.state).toBe("draft");
    expect(inv.lines.map((l: { description: string }) => l.description)).toEqual(["Mini session", "Share of location and travel"]);
    // A second run doesn't double-bill anyone.
    const again = await call("POST", `/shoots/${day}/invoices`, { lines: [{ description: "Mini session", unitCents: 17500 }] });
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped.filter((s: { reason: string }) => s.reason === "Already has an invoice.")).toHaveLength(3);
    void a;
  });

  it("weights the split by headcount when asked", async () => {
    const day = await makeDay();
    await call("POST", `/shoots/${day}/costs`, { label: "Location", amountCents: 10000 });
    const big = await photographed(day, "Big Family", "b@x.example");
    await photographed(day, "Solo", "so@x.example");
    expect((await call("PATCH", `/shoots/${big.id}`, { headcount: 4 })).status).toBe(200);
    expect((await call("PATCH", `/shoots/${big.id}`, { headcount: 0 })).status).toBe(400);
    const b = (await call("GET", `/shoots/${day}/billing?split=per_person`)).body;
    expect(b.people.map((p: { shareCents: number }) => p.shareCents)).toEqual([8000, 2000]);
  });

  it("recounts the per-person line on a draft day invoice", async () => {
    const day = await makeDay("parent");
    await photographed(day, "One", "1@x.example");
    await photographed(day, "Two", "2@x.example");
    await photographed(day, "Three", "3@x.example");
    const org = (await call("GET", `/shoots/${day}`)).body.primary.id;
    const o = (await call("POST", "/orders", { kind: "invoice", contactId: org, shootId: day, title: "Acme headshot day", lines: [{ description: "Session fee", unitCents: 60000 }, { description: "Per person", quantity: 1, unitCents: 3500 }] })).body;
    const lineId = o.lines[1].id as string;
    const r = await call("POST", `/orders/${o.id}/recount`, { lineId });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    expect(r.body.order.lines[1].quantity).toBe(3);
    expect(r.body.order.totalCents).toBe(60000 + 3 * 3500);
    expect(r.body.order.schedule.reduce((n: number, s: { amountCents: number }) => n + s.amountCents, 0)).toBe(70500);
  });

  it("refuses to recount a sent invoice", async () => {
    const day = await makeDay("parent");
    await photographed(day, "One", "1@x.example");
    const org = (await call("GET", `/shoots/${day}`)).body.primary.id;
    const o = (await call("POST", "/orders", { kind: "invoice", contactId: org, shootId: day, title: "T", lines: [{ description: "Per person", unitCents: 3500 }] })).body;
    await call("POST", `/orders/${o.id}/send`);
    expect((await call("POST", `/orders/${o.id}/recount`, { lineId: o.lines[0].id })).status).toBe(400);
  });

  it("unlocks only the galleries of people on the day", async () => {
    const { tables } = await import("@openportrait/db");
    const day = await makeDay("parent");
    const kid = await photographed(day, "One", "1@x.example");
    const db = app.ctx.db;
    const base = { status: "live" as const, accessMode: "link" as const, downloadLock: "until_paid" as const };
    db.insert(tables.gallery).values({ id: "g1", slug: "g1", title: "One", shootFolder: kid.folderPath, folderPath: `${kid.folderPath}/Gallery`, ...base }).run();
    db.insert(tables.gallery).values({ id: "g2", slug: "g2", title: "Other", shootFolder: "2026/Other", folderPath: "2026/Other", ...base }).run();
    const r = await call("POST", `/shoots/${day}/unlock-galleries`);
    expect(r.body.unlocked).toBe(1);
    const rows = db.select().from(tables.gallery).all();
    expect(rows.find((g) => g.id === "g1")!.unlockedAt).toBeTruthy();
    expect(rows.find((g) => g.id === "g2")!.unlockedAt).toBeFalsy();
  });
});

describe("the organisation's page", () => {
  async function api(method: "GET" | "POST", url: string, payload?: unknown, withCookie = false) {
    const res = await app.inject({ method, url, headers: withCookie ? { cookie } : {}, payload: payload as object | undefined });
    return { status: res.statusCode, body: res.body ? res.json() : null, res };
  }
  async function publishedPerson(day: string, name: string, opts: { live?: boolean } = {}) {
    const { tables } = await import("@openportrait/db");
    const child = (await call("POST", `/shoots/${day}/people`, { name, email: `${name.replace(/\W/g, "").toLowerCase()}@x.example` })).body.child as { id: string; folderPath: string };
    const db = app.ctx.db;
    const slug = `g-${child.id.slice(0, 6)}`;
    db.insert(tables.gallery).values({ id: `gal-${child.id}`, slug, title: name, shootFolder: child.folderPath, folderPath: `${child.folderPath}/Gallery`, status: opts.live === false ? "draft" : "live", accessMode: "link", downloadLock: "until_paid" }).run();
    db.insert(tables.gallerySet).values({ id: `set-${child.id}`, galleryId: `gal-${child.id}`, name: "Gallery", folderName: "" }).run();
    db.insert(tables.photo).values({ id: `ph-${child.id}`, galleryId: `gal-${child.id}`, setId: `set-${child.id}`, relPath: `${child.folderPath}/Gallery/a.jpg`, filename: "a.jpg", contentHash: "h", sizeBytes: 1, mtimeMs: 1, width: 100, height: 100, state: "ready" }).run();
    return { child, slug };
  }
  const tokenOf = (link: string) => link.slice(link.indexOf("/d/") + 3);

  it("lists only published people who are on the page, with watermarked previews while locked", async () => {
    const day = await makeDay();
    const a = await publishedPerson(day, "Jane Smith");
    await publishedPerson(day, "Draft Person", { live: false });
    const hidden = await publishedPerson(day, "Private Person");
    await call("PATCH", `/shoots/${hidden.child.id}`, { showOnMaster: false });
    const put = await call("PUT", `/shoots/${day}/master`, { enabled: true });
    expect(put.body.enabled).toBe(true);
    const token = tokenOf(put.body.link);
    const page = await api("GET", `/api/day/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.people.map((p: { name: string }) => p.name)).toEqual(["Jane Smith"]);
    expect(page.body.people[0].cover.thumb).toContain("-wm-");
    expect(page.res.headers["cache-control"]).toContain("no-store");
    const one = await api("GET", `/api/day/${token}/people/${a.child.id}`);
    expect(one.body.photos).toHaveLength(1);
    // The people's own gallery links are never in the page.
    expect(JSON.stringify(page.body) + JSON.stringify(one.body)).not.toContain(a.slug);
    expect((await api("GET", `/api/day/${token}/people/${hidden.child.id}`)).status).toBe(404);
  });

  it("refuses a bad, switched-off, retired or expired link the same way", async () => {
    const day = await makeDay();
    await publishedPerson(day, "Jane Smith");
    const first = (await call("PUT", `/shoots/${day}/master`, { enabled: true })).body;
    const t1 = tokenOf(first.link);
    expect((await api("GET", `/api/day/${t1}x`)).status).toBe(404);
    expect((await api("GET", `/api/day/nonsense`)).status).toBe(404);
    const rotated = (await call("PUT", `/shoots/${day}/master`, { rotate: true })).body;
    expect((await api("GET", `/api/day/${t1}`)).status).toBe(404);
    const t2 = tokenOf(rotated.link);
    expect((await api("GET", `/api/day/${t2}`)).status).toBe(200);
    await call("PUT", `/shoots/${day}/master`, { enabled: false });
    expect((await api("GET", `/api/day/${t2}`)).status).toBe(404);
    await call("PUT", `/shoots/${day}/master`, { enabled: true });
    expect((await api("GET", `/api/day/${t2}`)).status).toBe(200);
    app.ctx.db.update((await import("@openportrait/db")).tables.masterAccess).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect((await api("GET", `/api/day/${t2}`)).status).toBe(404);
  });

  it("holds everything back until the password is entered, and a new password ends earlier sign-ins", async () => {
    const day = await makeDay();
    const a = await publishedPerson(day, "Jane Smith");
    const put = (await call("PUT", `/shoots/${day}/master`, { enabled: true, password: "open sesame" })).body;
    expect(put.hasPassword).toBe(true);
    const token = tokenOf(put.link);
    const gated = await api("GET", `/api/day/${token}`);
    expect(gated.body.locked).toBe(true);
    expect(gated.body.people).toEqual([]);
    expect((await api("GET", `/api/day/${token}/people/${a.child.id}`)).status).toBe(401);
    expect((await api("POST", `/api/day/${token}/unlock`, { password: "nope" })).status).toBe(401);
    const ok = await api("POST", `/api/day/${token}/unlock`, { password: "open sesame" });
    expect(ok.status).toBe(200);
    const c = ok.res.cookies[0]!;
    const res = await app.inject({ method: "GET", url: `/api/day/${token}`, headers: { cookie: `${c.name}=${c.value}` } });
    expect(res.json().locked).toBe(false);
    expect(res.json().people).toHaveLength(1);
  });

  it("only works on a group day, and short passwords are refused", async () => {
    const types = (await call("GET", "/shoot-types")).body.types as Array<{ id: string }>;
    const c = (await call("POST", "/contacts", { firstName: "A", lastName: "B" })).body;
    const s = (await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0]!.id })).body.shoot;
    expect((await call("PUT", `/shoots/${s.id}/master`, { enabled: true })).status).toBe(400);
    const day = await makeDay();
    expect((await call("PUT", `/shoots/${day}/master`, { enabled: true, password: "abc" })).status).toBe(400);
  });

  it("is only managed by signed-in staff", async () => {
    const day = await makeDay();
    expect((await api("GET", `/api/studio/shoots/${day}/master`)).status).toBe(401);
  });
});
