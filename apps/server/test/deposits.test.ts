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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-deposit-"));
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


import { addDays, atTime, weekdayOf, ymdIn } from "../src/domain/time.js";
import { rebalance } from "../src/domain/orders.js";

async function contact() {
  return (await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
}
const coupon = (extra: object = {}) => staff("POST", "/coupons", { code: "SPRING25", kind: "percent", value: 2500, ...extra });
function monday() {
  let d = addDays(ymdIn(Date.now(), TZ), 10);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

describe("rebalance", () => {
  const rows = [{ label: "Deposit", amountCents: 30_000, dueDate: null }, { label: "Balance", amountCents: 70_000, dueDate: "2027-01-01" }];
  it("lets the balance absorb a smaller or larger total", () => {
    expect(rebalance(rows, 55_000).map((r) => r.amountCents)).toEqual([30_000, 25_000]);
    expect(rebalance(rows, 120_000).map((r) => r.amountCents)).toEqual([30_000, 90_000]);
  });
  it("eats into the deposit only when the balance is gone, and keeps one payment", () => {
    expect(rebalance(rows, 20_000).map((r) => [r.label, r.amountCents])).toEqual([["Deposit", 20_000]]);
    expect(rebalance(rows, 0)).toHaveLength(1);
  });
});

describe("coupons on a sent quote", () => {
  const lines = [{ description: "Wedding collection", unitCents: 100_000, taxable: false }];
  const schedule = [{ label: "Deposit", amountCents: 30_000 }, { label: "Balance", amountCents: 70_000, dueDate: "2099-01-01" }];
  async function sentQuote(extra: object = {}) {
    const q = await staff("POST", "/orders", { kind: "quote", contactId: await contact(), title: "Smith wedding", lines, schedule, ...extra });
    await staff("POST", `/orders/${q.body.id}/send`);
    return q.body as { id: string; token: string };
  }
  it("recalculates the total and takes the change off the balance, not the deposit", async () => {
    await coupon();
    const q = await sentQuote();
    const r = await pub("POST", `/order/${q.token}/coupon`, { code: " spring25 " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ couponCode: "SPRING25", couponCents: 25_000, totalCents: 75_000 });
    expect(r.body.schedule.map((s: { amountCents: number }) => s.amountCents)).toEqual([30_000, 45_000]);
    expect((await staff("GET", `/orders/${q.id}`)).body.totalCents).toBe(75_000);
    // It still accepts and becomes an invoice with the new amounts.
    const accepted = await pub("POST", `/order/${q.token}/accept`, { name: "Jane Smith" });
    expect(accepted.body).toMatchObject({ kind: "invoice", totalCents: 75_000 });
  });
  it("refuses bad codes, repeats, weaker replacements and quotes that are no longer open", async () => {
    await coupon();
    await coupon({ code: "SMALL", kind: "fixed", value: 1_000 });
    await coupon({ code: "PAGEONLY", schedulerId: (await staff("POST", "/schedulers", { name: "Mini", durationMinutes: 30, availability: {} })).body.id });
    const q = await sentQuote();
    expect((await pub("POST", `/order/${q.token}/coupon`, { code: "NOPE" })).body.message).toMatch(/don't have a coupon/);
    expect((await pub("POST", `/order/${q.token}/coupon`, { code: "PAGEONLY" })).body.message).toMatch(/one booking page/);
    await pub("POST", `/order/${q.token}/coupon`, { code: "SPRING25" });
    expect((await pub("POST", `/order/${q.token}/coupon`, { code: "SPRING25" })).body.message).toMatch(/already on this quote/);
    expect((await pub("POST", `/order/${q.token}/coupon`, { code: "SMALL" })).body.message).toMatch(/wouldn't save you more/);
    await pub("POST", `/order/${q.token}/accept`, { name: "Jane Smith" });
    expect((await pub("POST", `/order/${q.token}/coupon`, { code: "SPRING25" })).status).toBe(400);
  });
  it("counts toward a coupon's use limit", async () => {
    await coupon({ maxUses: 1 });
    const a = await sentQuote();
    const b = await sentQuote();
    expect((await pub("POST", `/order/${a.token}/coupon`, { code: "SPRING25" })).status).toBe(200);
    expect((await pub("POST", `/order/${b.token}/coupon`, { code: "SPRING25" })).body.message).toMatch(/most times/);
  });
});

describe("paid booking pages", () => {
  async function page(extra: object = {}) {
    const day = monday();
    const s = await staff("POST", "/schedulers", { name: "Mini session", durationMinutes: 30, approval: "auto", priceCents: 20_000, depositType: "percent", depositValue: 5_000, availability: { "1": [{ start: "09:00", end: "12:00" }] }, ...extra });
    return { s: s.body, day, at: atTime(day, "09:00", TZ) };
  }
  const who = { firstName: "Ana", email: "ana@example.com" };

  it("validates the price and deposit", async () => {
    const bad = await staff("POST", "/schedulers", { name: "X", durationMinutes: 30, priceCents: 10_000, depositType: "fixed", depositValue: 20_000, availability: {} });
    expect(bad.status).toBe(400);
    const free = (await staff("POST", "/schedulers", { name: "Free", durationMinutes: 30, depositType: "percent", depositValue: 500, availability: {} })).body;
    expect(free).toMatchObject({ priceCents: 0, depositType: "none", depositValue: 0 });
    expect((await pub("GET", `/book/${free.slug}`)).body.price).toBeNull();
  });
  it("shows the price and deposit, and previews a coupon", async () => {
    const { s } = await page();
    await coupon();
    expect((await pub("GET", `/book/${s.slug}`)).body.price).toMatchObject({ totalCents: 20_000, depositCents: 10_000, balanceCents: 10_000 });
    const p = (await pub("POST", `/book/${s.slug}/price`, { couponCode: "spring25" })).body.price;
    expect(p).toMatchObject({ couponCode: "SPRING25", couponCents: 5_000, totalCents: 15_000, depositCents: 7_500, balanceCents: 7_500 });
    expect((await pub("POST", `/book/${s.slug}/price`, { couponCode: "NOPE" })).status).toBe(400);
  });
  it("raises an invoice with a deposit and a balance due on the day", async () => {
    const { s, day, at } = await page();
    await coupon();
    const r = await pub("POST", `/book/${s.slug}`, { ...who, startsAt: at, couponCode: "SPRING25" });
    expect(r.status).toBe(201);
    expect(r.body.invoice).toMatchObject({ totalCents: 15_000, depositCents: 7_500 });
    const inv = (await pub("GET", `/order/${r.body.invoice.token}`)).body;
    expect(inv).toMatchObject({ kind: "invoice", title: "Mini session", couponCode: "SPRING25", totalCents: 15_000 });
    expect(inv.schedule.map((x: { label: string; amountCents: number; dueDate: string | null }) => [x.label, x.amountCents, x.dueDate])).toEqual([["Deposit", 7_500, null], ["Balance", 7_500, day]]);
    // The staff list shows it unpaid, then partly paid once the deposit comes in.
    const list = async () => (await staff("GET", "/bookings?status=confirmed")).body.items[0].payment;
    expect(await list()).toMatchObject({ status: "unpaid", totalCents: 15_000 });
    const orderId = (await staff("GET", "/orders?kind=invoice")).body.items[0].id;
    await staff("POST", `/orders/${orderId}/payments`, { amountCents: 7_500, method: "cash" });
    expect(await list()).toMatchObject({ status: "partial", paidCents: 7_500 });
  });
  it("a coupon for another page is refused before the time is held", async () => {
    const { s, at } = await page();
    const other = (await staff("POST", "/schedulers", { name: "Other", durationMinutes: 30, availability: {} })).body;
    await coupon({ code: "OTHER", schedulerId: other.id });
    await coupon({ code: "HERE", schedulerId: s.id });
    const bad = await pub("POST", `/book/${s.slug}`, { ...who, startsAt: at, couponCode: "OTHER" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/one booking page/);
    const good = await pub("POST", `/book/${s.slug}`, { ...who, startsAt: at, couponCode: "HERE" });
    expect(good.status).toBe(201); // the slot was still free after the refusal
    // A page-only coupon doesn't work on a quote either.
    const q = await staff("POST", "/orders", { kind: "quote", contactId: await contact(), title: "T", lines: [{ description: "x", unitCents: 1000 }], couponCode: "HERE" });
    expect(q.status).toBe(400);
  });
  it("charges in full when there is no deposit, and voids an unpaid invoice when the client cancels", async () => {
    const { s, at } = await page({ depositType: "none", depositValue: 0 });
    const r = await pub("POST", `/book/${s.slug}`, { ...who, startsAt: at });
    expect(r.body.invoice).toMatchObject({ totalCents: 20_000, depositCents: 0 });
    expect((await pub("GET", `/order/${r.body.invoice.token}`)).body.schedule).toHaveLength(1);
    await pub("POST", `/book-cancel/${r.body.cancelToken}`);
    expect((await pub("GET", `/order/${r.body.invoice.token}`)).body.state).toBe("void");
  });
  it("keeps free pages free", async () => {
    const { s, at } = await page({ priceCents: 0 });
    expect((await pub("POST", `/book/${s.slug}`, { ...who, startsAt: at })).body.invoice).toBeNull();
  });
});
