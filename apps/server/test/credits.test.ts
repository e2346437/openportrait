import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-credits-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, logger: false });
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


async function contact() {
  return (await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
}
const wedding = [{ description: "Wedding collection", unitCents: 100_000, taxable: false }];
async function quoteFor(contactId: string, extra: object = {}) {
  return staff("POST", "/orders", { kind: "quote", contactId, title: "Smith wedding", lines: wedding, ...extra });
}
async function invoice(contactId: string, extra: object = {}) {
  const q = await quoteFor(contactId, extra);
  await staff("POST", `/orders/${q.body.id}/send`);
  await pub("POST", `/order/${q.body.token}/accept`, { name: "Jane Smith" });
  return { id: q.body.id as string, token: q.body.token as string };
}
const coupon = (extra: object = {}) => staff("POST", "/coupons", { code: "spring25", kind: "percent", value: 2500, ...extra });

describe("coupons", () => {
  it("creates codes in capitals and refuses duplicates and nonsense", async () => {
    const c = await coupon({ description: "Spring special" });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: "SPRING25", summary: "25% off", uses: 0 });
    expect((await coupon()).status).toBe(409);
    expect((await coupon({ code: "x" })).body.message).toMatch(/3 to 32/);
    expect((await coupon({ code: "BIG", value: 20_000 })).body.message).toMatch(/more than 100/);
    expect((await coupon({ code: "NODATE", expiresOn: "soon" })).body.message).toMatch(/year-month-day/);
  });
  it("takes a percentage off a quote and keeps the manual discount separate", async () => {
    await coupon();
    const id = await contact();
    const q = await quoteFor(id, { couponCode: "spring25", discountCents: 5_000 });
    expect(q.body).toMatchObject({ couponCode: "SPRING25", couponCents: 25_000, discountCents: 5_000, subtotalCents: 100_000, totalCents: 70_000 });
    const saved = await staff("PUT", `/orders/${q.body.id}`, { contactId: id, title: "Smith wedding", lines: wedding, couponCode: "SPRING25", discountCents: 5_000 });
    expect(saved.body).toMatchObject({ couponCents: 25_000, discountCents: 5_000, totalCents: 70_000 });
    const cleared = await staff("PUT", `/orders/${q.body.id}`, { contactId: id, title: "Smith wedding", lines: wedding, couponCode: "" });
    expect(cleared.body).toMatchObject({ couponCode: null, couponCents: 0, totalCents: 100_000 });
  });
  it("shows the coupon on the client's page", async () => {
    await coupon({ code: "TENOFF", kind: "fixed", value: 10_000 });
    const { token } = await invoice(await contact(), { couponCode: "tenoff" });
    expect((await pub("GET", `/order/${token}`)).body).toMatchObject({ couponCode: "TENOFF", couponCents: 10_000, totalCents: 90_000 });
  });
  it("only discounts the product it is for", async () => {
    const item = (await staff("POST", "/catalog", { name: "Album", priceCents: 40_000 })).body;
    await coupon({ code: "ALBUM", itemId: item.id, value: 5000 });
    const id = await contact();
    const lines = [{ description: "Wedding collection", unitCents: 100_000 }, { itemId: item.id, description: "Album", unitCents: 40_000 }];
    const q = await quoteFor(id, { lines, couponCode: "ALBUM" });
    expect(q.body.couponCents).toBe(20_000);
    const none = await quoteFor(id, { lines: wedding, couponCode: "ALBUM" });
    expect(none.status).toBe(400);
    expect(none.body.message).toMatch(/specific product/);
  });
  it("won't apply an unknown, switched-off, expired or used-up code", async () => {
    const id = await contact();
    expect((await quoteFor(id, { couponCode: "NOPE" })).body.message).toMatch(/don't have a coupon called NOPE/);
    const off = (await coupon({ code: "OFF" })).body;
    await staff("PUT", `/coupons/${off.id}`, { code: "OFF", kind: "percent", value: 1000, active: false });
    expect((await quoteFor(id, { couponCode: "OFF" })).body.message).toMatch(/isn't active/);
    await coupon({ code: "OLD", expiresOn: "2020-01-01" });
    expect((await quoteFor(id, { couponCode: "OLD" })).body.message).toMatch(/expired on 2020-01-01/);
    await coupon({ code: "ONCE", maxUses: 1 });
    expect((await quoteFor(id, { couponCode: "ONCE" })).status).toBe(201);
    expect((await quoteFor(id, { couponCode: "ONCE" })).body.message).toMatch(/most times/);
  });
  it("frees a use when the quote is deleted, and keeps a promised coupon after it expires", async () => {
    await coupon({ code: "ONCE", maxUses: 1 });
    const id = await contact();
    const first = await quoteFor(id, { couponCode: "ONCE" });
    await staff("DELETE", `/orders/${first.body.id}`);
    const second = await quoteFor(id, { couponCode: "ONCE" });
    expect(second.status).toBe(201);
    const row = (await staff("GET", "/coupons")).body.items[0];
    await staff("PUT", `/coupons/${row.id}`, { code: "ONCE", kind: "percent", value: 2500, maxUses: 1, expiresOn: "2020-01-01" });
    const resaved = await staff("PUT", `/orders/${second.body.id}`, { contactId: id, title: "Smith wedding", lines: [{ description: "Wedding collection", unitCents: 200_000, taxable: false }], couponCode: "ONCE" });
    expect(resaved.status).toBe(200);
    expect(resaved.body.couponCents).toBe(50_000);
  });
  it("is removed only if it was never used", async () => {
    const a = (await coupon({ code: "AAA" })).body;
    expect((await staff("DELETE" as never, `/coupons/${a.id}`)).body).toMatchObject({ removed: true });
    const b = (await coupon({ code: "BBB" })).body;
    await quoteFor(await contact(), { couponCode: "BBB" });
    expect((await staff("DELETE" as never, `/coupons/${b.id}`)).body).toMatchObject({ removed: false, deactivated: true });
  });
  it("is owner-only to create", async () => {
    const r = await app.inject({ method: "POST", url: "/api/studio/coupons", payload: { code: "XYZ", kind: "percent", value: 100 } });
    expect(r.statusCode).toBe(401);
  });
});

describe("client credit", () => {
  it("adds and removes credit, and never goes below zero", async () => {
    const id = await contact();
    const g = await staff("POST", `/contacts/${id}/credit`, { amountCents: 25_000, note: "Gift card" });
    expect(g.body.balanceCents).toBe(25_000);
    expect((await staff("POST", `/contacts/${id}/credit`, { amountCents: 0 })).body.message).toMatch(/greater than zero/);
    expect((await staff("POST", `/contacts/${id}/credit/remove`, { amountCents: 30_000 })).body.message).toMatch(/only has \$250/);
    const r = await staff("POST", `/contacts/${id}/credit/remove`, { amountCents: 5_000, note: "Mistake" });
    expect(r.body.balanceCents).toBe(20_000);
    expect(r.body.entries.map((e: { kind: string }) => e.kind)).toEqual(["removed", "grant"]);
  });
  it("pays part of an invoice from credit, from the studio side", async () => {
    const id = await contact();
    await staff("POST", `/contacts/${id}/credit`, { amountCents: 30_000 });
    const inv = await invoice(id);
    expect((await staff("GET", `/orders/${inv.id}`)).body.creditAvailableCents).toBe(30_000);
    const r = await staff("POST", `/orders/${inv.id}/apply-credit`, { amountCents: 10_000 });
    expect(r.body).toMatchObject({ paidCents: 10_000, creditAvailableCents: 20_000 });
    expect(r.body.payments[0]).toMatchObject({ method: "credit", amountCents: 10_000 });
    expect((await staff("GET", `/contacts/${id}/credit`)).body.balanceCents).toBe(20_000);
    expect((await staff("POST", `/orders/${inv.id}/apply-credit`, { amountCents: 25_000 })).body.message).toMatch(/Only \$200/);
  });
  it("lets the client use their credit from their link, capped at what they owe", async () => {
    const id = await contact();
    await staff("POST", `/contacts/${id}/credit`, { amountCents: 150_000 });
    const { token } = await invoice(id);
    expect((await pub("GET", `/order/${token}`)).body.credit).toEqual({ availableCents: 100_000 });
    const r = await pub("POST", `/order/${token}/credit`);
    expect(r.body).toMatchObject({ state: "paid", paidCents: 100_000, balanceCents: 0, credit: null });
    expect((await staff("GET", `/contacts/${id}/credit`)).body.balanceCents).toBe(50_000);
    expect((await pub("POST", `/order/${token}/credit`)).status).toBe(400);
  });
  it("does not offer credit to a client who has none, and can't be faked as a payment", async () => {
    const id = await contact();
    const inv = await invoice(id);
    expect((await pub("GET", `/order/${inv.token}`)).body.credit).toBeNull();
    const fake = await staff("POST", `/orders/${inv.id}/payments`, { amountCents: 1000, method: "credit" });
    expect(fake.status).toBe(400);
    expect(fake.body.message).toMatch(/Apply credit/);
  });
  it("turns a refund into credit when asked", async () => {
    const id = await contact();
    const inv = await invoice(id);
    await staff("POST", `/orders/${inv.id}/payments`, { amountCents: 100_000, method: "cash" });
    await staff("POST", `/orders/${inv.id}/refunds`, { amountCents: 40_000, method: "credit" });
    const c = (await staff("GET", `/contacts/${id}/credit`)).body;
    expect(c.balanceCents).toBe(40_000);
    expect(c.entries[0]).toMatchObject({ kind: "refund", amountCents: 40_000 });
    expect((await staff("GET", `/orders/${inv.id}`)).body.paidCents).toBe(60_000);
  });
});
