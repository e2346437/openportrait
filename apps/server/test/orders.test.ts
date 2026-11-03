import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";
import { totalsFor } from "../src/domain/money.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let sent: Array<{ to: unknown; subject: string; text: string }>;
const TZ = "America/Chicago";
const smtp = { host: "smtp.example.com", port: 587, security: "starttls", user: "u", password: "secret-pass", fromName: "Lumen Studio", fromAddress: "hello@example.com" };

beforeEach(async () => {
  sent = [];
  setTransportFactory(() => ({
    sendMail: async (m: { to: unknown; subject: string; text: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
      return {} as never;
    },
  }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-orders-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: TZ } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  app.ctx.settings.set("studio.email", "owner@example.com");
  await app.inject({ method: "PUT", url: "/api/studio/email", payload: smtp, headers: { cookie } });
});
afterEach(async () => {
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const staff = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const pub = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/public${url}`, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};

let contactId: string;
const lines = [
  { description: "Wedding collection", unitCents: 300_000 },
  { description: "Extra hour", quantity: 2, unitCents: 25_000 },
  { description: "Gift card", unitCents: 10_000, taxable: false },
];
async function quote(extra: object = {}) {
  const c = await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" });
  contactId = c.body.id;
  return staff("POST", "/orders", { kind: "quote", contactId, title: "Smith wedding", lines, ...extra });
}

describe("totals", () => {
  it("charges tax only on what the client pays for taxable lines", () => {
    const t = totalsFor([{ quantity: 1, unitCents: 10_000, taxable: true }, { quantity: 1, unitCents: 10_000, taxable: false }], 5_000, 1000);
    // $50 discount is split evenly between the lines: $25 off the taxable one, so tax is 10% of $75.
    expect(t).toEqual({ subtotalCents: 20_000, discountCents: 5_000, taxCents: 750, totalCents: 15_750 });
  });
  it("never lets a discount go below zero", () => {
    expect(totalsFor([{ quantity: 1, unitCents: 1_000, taxable: true }], 99_999, 825).totalCents).toBe(0);
  });
});

describe("quotes", () => {
  it("drafts a quote with tax from the studio rate, numbered from 1001", async () => {
    await staff("PUT", "/money/settings", { currency: "usd", taxBps: 825, terms: "Net 30.", paymentInstructions: "Venmo @lumen", quoteValidDays: 14 });
    const q = await quote();
    expect(q.status).toBe(201);
    // taxable: 300000 + 50000 = 350000 -> 8.25% = 28875; gift card is not taxed.
    expect(q.body).toMatchObject({ kind: "quote", label: "Quote 1001", state: "draft", subtotalCents: 360_000, taxCents: 28_875, totalCents: 388_875, terms: "Net 30." });
    expect(q.body.schedule).toEqual([expect.objectContaining({ label: "Payment in full", amountCents: 388_875 })]);
    expect((await staff("POST", "/orders", { kind: "quote", contactId, title: "Second", lines })).body.label).toBe("Quote 1002");
  });

  it("rejects bad input in plain words", async () => {
    await quote();
    const bad = (extra: object) => staff("POST", "/orders", { kind: "quote", contactId, title: "X", lines, ...extra });
    expect((await bad({ title: " " })).body.message).toMatch(/title/);
    expect((await bad({ lines: [] })).body.message).toMatch(/at least one line/);
    expect((await bad({ lines: [{ description: "A", unitCents: 12.5 }] })).body.message).toMatch(/valid price/);
    expect((await bad({ schedule: [{ label: "Deposit", amountCents: 100 }] })).body.message).toMatch(/add up to/);
    expect((await bad({ validUntil: "next week" })).body.message).toMatch(/year-month-day/);
  });

  it("only lets a draft be edited, and edits replace lines and payments", async () => {
    const q = (await quote()).body;
    const edited = await staff("PUT", `/orders/${q.id}`, { contactId, title: "Smith wedding", lines: [{ description: "Elopement", unitCents: 100_000 }], schedule: [{ label: "Deposit", amountCents: 40_000 }, { label: "Balance", amountCents: 60_000, dueDate: "2027-05-01" }] });
    expect(edited.body).toMatchObject({ totalCents: 100_000, lines: [expect.objectContaining({ description: "Elopement" })] });
    expect(edited.body.schedule).toHaveLength(2);
    await staff("POST", `/orders/${q.id}/send`);
    expect((await staff("PUT", `/orders/${q.id}`, { contactId, title: "Nope", lines })).status).toBe(400);
    expect((await staff("DELETE", `/orders/${q.id}`)).status).toBe(400);
    const back = await staff("POST", `/orders/${q.id}/reopen`);
    expect(back.body.state).toBe("draft");
  });

  it("emails the client a private link when sent, and a draft has no public page", async () => {
    const q = (await quote()).body;
    expect((await pub("GET", `/order/${q.token}`)).status).toBe(404);
    const s = await staff("POST", `/orders/${q.id}/send`);
    expect(s.body).toMatchObject({ state: "sent", emailed: true });
    await app.ctx.jobs.drain();
    const mail = sent.find((m) => /your quote/.test(m.subject));
    expect(mail?.text).toContain(`/o/${q.token}`);
    expect((await staff("POST", `/orders/${q.id}/send`)).status).toBe(400);
  });

  it("won't send to a contact with no email", async () => {
    const c = await staff("POST", "/contacts", { firstName: "No", lastName: "Mail" });
    const q = (await staff("POST", "/orders", { kind: "quote", contactId: c.body.id, title: "T", lines })).body;
    expect((await staff("POST", `/orders/${q.id}/send`)).body.message).toMatch(/email address/);
  });
});

describe("accepting, paying and refunding", () => {
  async function accepted() {
    const q = (await quote({ lines: [{ description: "Session", unitCents: 100_000 }], schedule: [{ label: "Deposit", amountCents: 30_000 }, { label: "Balance", amountCents: 70_000, dueDate: "2020-01-01" }] })).body;
    await staff("POST", `/orders/${q.id}/send`);
    const done = await pub("POST", `/order/${q.token}/accept`, { name: "Jane Smith" });
    return { id: q.id, token: q.token, done };
  }

  it("turns the quote into an invoice in place, and keeps the link working", async () => {
    const { id, token, done } = await accepted();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ kind: "invoice", label: "Invoice 1001", state: "unpaid", acceptedName: "Jane Smith" });
    expect((await staff("GET", `/orders/${id}`)).body).toMatchObject({ kind: "invoice", label: "Invoice 1001" });
    expect((await pub("POST", `/order/${token}/accept`, { name: "Jane Smith" })).status).toBe(400);
    expect(sent.some((m) => /accepted/.test(m.subject))).toBe(false); // queued, not yet delivered
    await app.ctx.jobs.drain();
    expect(sent.some((m) => m.to === "owner@example.com" && /accepted/.test(m.subject))).toBe(true);
  });

  it("needs a typed name, and expired quotes can't be accepted", async () => {
    const q = (await quote({ validUntil: "2020-01-01" })).body;
    await staff("POST", `/orders/${q.id}/send`);
    expect((await pub("GET", `/order/${q.token}`)).body.state).toBe("expired");
    expect((await pub("POST", `/order/${q.token}/accept`, { name: "Jane" })).body.message).toMatch(/expired/);
    const q2 = (await quote()).body;
    await staff("POST", `/orders/${q2.id}/send`);
    expect((await pub("POST", `/order/${q2.token}/accept`, { name: "J" })).body.message).toMatch(/full name/);
    const declined = await pub("POST", `/order/${q2.token}/decline`, { reason: "Too pricey" });
    expect(declined.body.state).toBe("declined");
  });

  it("records payments against the schedule in order and rejects overpayment", async () => {
    const { id } = await accepted();
    const first = await staff("POST", `/orders/${id}/payments`, { amountCents: 30_000, method: "venmo" });
    expect(first.body).toMatchObject({ state: "partial", paidCents: 30_000, balanceCents: 70_000 });
    expect(first.body.schedule.map((s: { status: string }) => s.status)).toEqual(["paid", "overdue"]);
    expect((await staff("POST", `/orders/${id}/payments`, { amountCents: 70_001, method: "cash" })).body.message).toMatch(/more than/);
    expect((await staff("POST", `/orders/${id}/payments`, { amountCents: 0, method: "cash" })).status).toBe(400);
    const last = await staff("POST", `/orders/${id}/payments`, { amountCents: 70_000, method: "check", note: "#118" });
    expect(last.body).toMatchObject({ state: "paid", balanceCents: 0 });
    await app.ctx.jobs.drain();
    expect(sent.filter((m) => /Receipt/.test(m.subject))).toHaveLength(2);
  });

  it("refunds up to what was paid, and won't void an invoice with money on it", async () => {
    const { id } = await accepted();
    await staff("POST", `/orders/${id}/payments`, { amountCents: 30_000, method: "cash" });
    expect((await staff("POST", `/orders/${id}/void`)).status).toBe(400);
    expect((await staff("POST", `/orders/${id}/refunds`, { amountCents: 30_001, method: "cash" })).status).toBe(400);
    const r = await staff("POST", `/orders/${id}/refunds`, { amountCents: 30_000, method: "cash" });
    expect(r.body).toMatchObject({ paidCents: 0, state: "unpaid" });
    expect((await staff("POST", `/orders/${id}/void`)).body.state).toBe("void");
  });

  it("lists and filters, and keeps the timeline", async () => {
    const { id } = await accepted();
    const payer = contactId;
    await quote();
    expect((await staff("GET", "/orders?kind=invoice")).body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await staff("GET", "/orders?q=smith")).body.items).toHaveLength(2);
    const timeline = (await staff("GET", `/contacts/${payer}`)).body.timeline.map((t: { text: string }) => t.text).join("|");
    expect(timeline).toMatch(/accepted Quote 1001/);
  });
});

describe("catalog", () => {
  it("creates, edits and archives items, and owners only", async () => {
    const made = await staff("POST", "/catalog", { kind: "package", name: "Mini session", priceCents: 25_000 });
    expect(made.status).toBe(201);
    await staff("PATCH", `/catalog/${made.body.id}`, { kind: "package", name: "Mini session", priceCents: 27_500, description: "20 minutes" });
    expect((await staff("GET", "/catalog")).body.items[0]).toMatchObject({ priceCents: 27_500 });
    await staff("POST", `/catalog/${made.body.id}/archive`, {});
    expect((await staff("GET", "/catalog")).body.items).toHaveLength(0);
    expect((await staff("POST", "/catalog", { name: "", priceCents: 1 })).status).toBe(400);
  });

  it("builds packages from products and keeps auto prices in step", async () => {
    const hours = (await staff("POST", "/catalog", { name: "Coverage hour", priceCents: 30_000 })).body;
    const album = (await staff("POST", "/catalog", { name: "Album", priceCents: 50_000 })).body;
    const pkg = await staff("POST", "/catalog", { kind: "package", name: "Wedding", priceCents: 0, autoPrice: true, components: [{ itemId: hours.id, quantity: 8 }, { itemId: album.id, quantity: 1 }] });
    expect(pkg.status).toBe(201);
    expect(pkg.body).toMatchObject({ autoPrice: true, priceCents: 290_000 });
    await staff("PATCH", `/catalog/${album.id}`, { name: "Album", priceCents: 60_000 });
    const listed = (await staff("GET", "/catalog")).body.items.find((i: { id: string }) => i.id === pkg.body.id);
    expect(listed).toMatchObject({ priceCents: 300_000 });
    expect(listed.components).toEqual([{ itemId: hours.id, quantity: 8 }, { itemId: album.id, quantity: 1 }]);
    const custom = await staff("PATCH", `/catalog/${pkg.body.id}`, { name: "Wedding", priceCents: 250_000, autoPrice: false, components: listed.components });
    expect(custom.body).toMatchObject({ autoPrice: false, priceCents: 250_000 });
    const bad = await staff("POST", "/catalog", { kind: "package", name: "Nested", priceCents: 1, components: [{ itemId: pkg.body.id, quantity: 1 }] });
    expect(bad.status).toBe(400);
  });
});

describe("formatted intro and terms", () => {
  it("cleans markup on the way in and out, and keeps plain text as it was", async () => {
    contactId = (await staff("POST", "/contacts", { firstName: "Rich", lastName: "Text", email: "rich@example.com" })).body.id;
    const lines = [{ description: "Session", quantity: 1, unitCents: 10_000 }];
    const q = await staff("POST", "/orders", { kind: "quote", contactId, title: "R", lines, intro: '<p>Hi <strong>there</strong><script>x()</script></p>', terms: "Net 30.\nNo refunds." });
    expect(q.status).toBe(201);
    expect(q.body.intro).toBe("<p>Hi <strong>there</strong></p>");
    expect(q.body.terms).toBe("Net 30.\nNo refunds.");
    const empty = await staff("PUT", `/orders/${q.body.id}`, { contactId, title: "R", lines, intro: "<p><br></p>", terms: '<ul><li onclick="x">One</li></ul>' });
    expect(empty.body.intro).toBeNull();
    expect(empty.body.terms).toBe("<ul><li>One</li></ul>");
    await staff("PUT", "/money/settings", { currency: "usd", terms: "<p>Default <em>terms</em><img src=x onerror=y></p>", paymentInstructions: "", quoteValidDays: 14 });
    expect((await staff("GET", "/money/settings")).body.terms).toBe("<p>Default <em>terms</em></p>");
  });
});

describe("sales tax places", () => {
  it("keeps several rates, one default, and fixes the rate on each document", async () => {
    expect((await staff("GET", "/money/tax-rates")).body.rates).toEqual([]);
    const saved = await staff("PUT", "/money/tax-rates", { rates: [
      { state: "ME", name: "Maine sales tax", rateBps: 550, registration: "12-345", isDefault: true },
      { state: "MA", name: "", rateBps: 625 },
    ] });
    expect(saved.status).toBe(200);
    const [me, ma] = saved.body.rates;
    expect(me).toMatchObject({ isDefault: true, rateBps: 550 });
    expect(ma.isDefault).toBe(false);
    expect((await staff("GET", "/money/settings")).body.taxBps).toBe(550);

    contactId = (await staff("POST", "/contacts", { firstName: "Tax", lastName: "Payer", email: "tax@example.com" })).body.id;
    const lines = [{ description: "Session", quantity: 1, unitCents: 100_000 }];
    const q1 = await staff("POST", "/orders", { kind: "quote", contactId, title: "A", lines });
    expect(q1.body).toMatchObject({ taxBps: 550, taxCents: 5_500, taxLabel: "Maine sales tax", taxRateId: me.id });
    const q2 = await staff("POST", "/orders", { kind: "quote", contactId, title: "B", lines, taxRateId: ma.id });
    expect(q2.body).toMatchObject({ taxBps: 625, taxCents: 6_250, taxRateId: ma.id });

    // Editing the Maine rate later leaves the saved quote alone until it is edited as a draft, which keeps its own place.
    await staff("PUT", "/money/tax-rates", { rates: [{ id: me.id, state: "ME", name: "Maine sales tax", rateBps: 600, isDefault: true }, { id: ma.id, state: "MA", name: "", rateBps: 625 }] });
    const again = await staff("PUT", `/orders/${q2.body.id}`, { contactId, title: "B", lines });
    expect(again.body).toMatchObject({ taxBps: 625, taxRateId: ma.id });
    expect((await staff("PUT", "/money/tax-rates", { rates: [{ state: "ME", name: "x", rateBps: 6000 }] })).status).toBe(400);
  });
});

describe("AI tools", () => {
  it("keeps every invoicing tool in one switchable group", async () => {
    const { allTools } = await import("../src/ai/registry.js");
    const mine = allTools().filter((t) => ["quotes", "orders"].includes(t.area) || t.name === "catalog_list");
    expect(mine.length).toBeGreaterThanOrEqual(6);
    expect(mine.every((t) => t.capability === "invoicing")).toBe(true);
  });
});
