import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let cookie: string;
const DAY = 86_400_000;

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const home = async () => (await call("GET", "/home")).body;

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-home-"));
  app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") }), startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
});

async function contact(first = "Jane") {
  return (await call("POST", "/contacts", { firstName: first, lastName: "Smith", email: `${first.toLowerCase()}@example.com` })).body.id as string;
}
async function typeId() {
  return (await call("GET", "/shoot-types")).body.types[0].id as string;
}

describe("home summary", () => {
  it("needs a signed-in owner", async () => {
    expect((await app.inject("/api/studio/home")).statusCode).toBe(401);
  });

  it("starts empty", async () => {
    const h = await home();
    expect(h.pulse).toEqual({ openLeads: 0, newLeadsThisWeek: 0, monthShoots: 0, monthBookedCents: 0, outstandingCents: 0, outstandingInvoices: 0, overdueInvoices: 0, galleriesToDeliver: 0, galleriesDeliveredThisYear: 0 });
    expect(h.upcoming).toEqual([]);
    expect(h.needs).toEqual([]);
    expect(h.hero).toBeNull();
  });

  it("counts leads, this week's shoots with their readiness, and money owed", async () => {
    const contactId = await contact();
    await call("POST", "/leads", { contactId });
    const start = Date.now() + 2 * DAY;
    const shoot = (await call("POST", "/shoots", { primaryContactId: contactId, shootTypeId: await typeId(), subject: "Smith portraits", events: [{ startsAt: start, endsAt: start + 3_600_000, location: "Studio" }] })).body;
    const shootId = shoot.shoot?.id ?? shoot.id;
    // An invoice for the shoot: a deposit paid, the balance overdue.
    const inv = (await call("POST", "/orders", { kind: "invoice", contactId, shootId, title: "Portraits", lines: [{ description: "Session", unitCents: 50_000, taxable: false }], schedule: [{ label: "Deposit", amountCents: 20_000 }, { label: "Balance", amountCents: 30_000, dueDate: "2020-01-01" }] })).body;
    expect((await call("POST", `/orders/${inv.id}/send`)).status).toBe(200);
    expect((await call("POST", `/orders/${inv.id}/payments`, { amountCents: 20_000, method: "cash" })).status).toBe(200);
    // A contract sent but not signed.
    const t = (await call("POST", "/contract-templates", { name: "Basic", body: "Agreement between {{studio.name}} and {{client.name}}." })).body;
    const c = (await call("POST", "/contracts", { contactId, templateId: t.id, shootId })).body;
    await call("POST", `/contracts/${c.id}/send`);

    const h = await home();
    expect(h.pulse).toMatchObject({ openLeads: 1, newLeadsThisWeek: 1, outstandingCents: 30_000, outstandingInvoices: 1, overdueInvoices: 1 });
    expect(h.upcoming).toHaveLength(1);
    expect(h.upcoming[0]).toMatchObject({ source: "shoot", shootId, location: "Studio", readiness: { contract: "sent", deposit: "paid", questionnaire: "none" } });
    const keys = h.needs.map((n: { key: string }) => n.key);
    expect(keys).toEqual(expect.arrayContaining(["inquiries", "overdue", "contracts"]));
    const overdue = h.needs.find((n: { key: string }) => n.key === "overdue");
    expect(overdue).toMatchObject({ count: 1, to: "/studio/orders", action: "Remind", tone: "bad" });
    expect(overdue.detail).toContain("Jane Smith");
    expect(h.needs.find((n: { key: string }) => n.key === "contracts")).toMatchObject({ count: 1, title: "Contract unsigned" });
  });

  it("counts this month's shoots and their invoices", async () => {
    const contactId = await contact();
    const now = new Date();
    // A shoot later this month (or, at month end, the last hour of today).
    const start = Math.min(now.getTime() + 6 * 3_600_000, Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 0));
    const s = (await call("POST", "/shoots", { primaryContactId: contactId, shootTypeId: await typeId(), subject: "Smith", events: [{ startsAt: start, endsAt: start + 3_600_000 }] })).body;
    const shootId = s.shoot?.id ?? s.id;
    const inv = (await call("POST", "/orders", { kind: "invoice", contactId, shootId, title: "Session", lines: [{ description: "Session", unitCents: 12_500, taxable: false }] })).body;
    await call("POST", `/orders/${inv.id}/send`);
    const h = await home();
    expect(h.pulse).toMatchObject({ monthShoots: 1, monthBookedCents: 12_500, outstandingCents: 12_500, overdueInvoices: 0 });
  });
});
