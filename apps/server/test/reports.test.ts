import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { tables } from "@openportrait/db";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";
import { toCsv } from "../src/domain/reports.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
const smtp = { host: "smtp.example.com", port: 587, security: "starttls", user: "u", password: "secret-pass", fromName: "Lumen Studio", fromAddress: "hello@example.com" };

beforeEach(async () => {
  setTransportFactory(() => ({ sendMail: async () => ({}) as never }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-reports-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  await app.inject({ method: "PUT", url: "/api/studio/email", payload: smtp, headers: { cookie } });
});
afterEach(async () => {
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const staff = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body && r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body };
};

/** An accepted invoice of `cents`, optionally linked to a shoot, issued and paid on the given days. */
async function invoice(opts: { cents: number; shootId?: string; issued: string; paid?: Array<{ cents: number; on: string; method?: string }>; schedule?: Array<{ label: string; amountCents: number; dueDate?: string }> }) {
  const c = (await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
  const q = (await staff("POST", "/orders", { kind: "quote", contactId: c, shootId: opts.shootId, title: "Session", lines: [{ description: "Session", unitCents: opts.cents, taxable: false }], schedule: opts.schedule })).body;
  await staff("POST", `/orders/${q.id}/send`);
  const pub = await app.inject({ method: "POST", url: `/api/public/order/${q.token}/accept`, payload: { name: "Jane Smith" } });
  expect(pub.statusCode).toBe(200);
  app.ctx.db.update(tables.order).set({ acceptedAt: new Date(`${opts.issued}T18:00:00Z`) }).where(eq(tables.order.id, q.id)).run();
  for (const p of opts.paid ?? []) {
    const r = await staff("POST", `/orders/${q.id}/payments`, { amountCents: p.cents, method: p.method ?? "check" });
    expect(r.status).toBe(200);
  }
  // Move each payment to the day the test wants, oldest first.
  const rows = app.ctx.db.select().from(tables.payment).where(eq(tables.payment.orderId, q.id)).orderBy(tables.payment.createdAt).all();
  (opts.paid ?? []).forEach((p, i) => app.ctx.db.update(tables.payment).set({ paidAt: new Date(`${p.on}T18:00:00Z`) }).where(eq(tables.payment.id, rows[i]!.id)).run());
  return q.id as string;
}

describe("financial report", () => {
  it("adds up income by month, shoot type and payment method", async () => {
    const types = (await staff("GET", "/shoot-types")).body.types as Array<{ id: string; name: string }>;
    const c = (await staff("POST", "/contacts", { firstName: "Sam", lastName: "Lee" })).body.id as string;
    const wedding = (await staff("POST", "/shoots", { primaryContactId: c, shootTypeId: types.find((t) => t.name === "Wedding")!.id })).body.shoot.id as string;
    await invoice({ cents: 200_000, shootId: wedding, issued: "2026-01-10", paid: [{ cents: 50_000, on: "2026-01-12", method: "card" }, { cents: 150_000, on: "2026-02-03", method: "check" }] });
    await invoice({ cents: 30_000, issued: "2026-02-20", paid: [{ cents: 10_000, on: "2026-02-21", method: "cash" }] });
    const r = (await staff("GET", "/reports/financial?from=2026-01-01&to=2026-02-28")).body;
    expect(r.totals).toMatchObject({ invoicedCents: 230_000, collectedCents: 210_000, netCollectedCents: 210_000, invoiceCount: 2, paymentCount: 3 });
    expect(r.byMonth).toEqual([
      { month: "2026-01", invoicedCents: 200_000, collectedCents: 50_000, refundedCents: 0 },
      { month: "2026-02", invoicedCents: 30_000, collectedCents: 160_000, refundedCents: 0 },
    ]);
    expect(r.byShootType.find((t: { name: string }) => t.name === "Wedding")).toMatchObject({ invoicedCents: 200_000, collectedCents: 200_000 });
    expect(r.byShootType.find((t: { name: string }) => t.name === "No shoot linked")).toMatchObject({ invoicedCents: 30_000, collectedCents: 10_000 });
    expect(r.byMethod.map((m: { method: string }) => m.method)).toEqual(["check", "card", "cash"]);
    // Only what is still owed today, whatever the range.
    expect(r.outstanding).toMatchObject({ totalCents: 20_000, count: 1 });
  });

  it("limits to the range, subtracts refunds, and ignores drafts and void invoices", async () => {
    const id = await invoice({ cents: 100_000, issued: "2026-03-05", paid: [{ cents: 100_000, on: "2026-03-06" }] });
    await staff("POST", `/orders/${id}/refunds`, { amountCents: 20_000, method: "check" });
    app.ctx.db.update(tables.payment).set({ paidAt: new Date("2026-04-02T18:00:00Z") }).where(eq(tables.payment.amountCents, -20_000)).run();
    const c = (await staff("POST", "/contacts", { firstName: "A", lastName: "B" })).body.id as string;
    await staff("POST", "/orders", { kind: "quote", contactId: c, title: "Draft", lines: [{ description: "x", unitCents: 99_999 }] });
    const march = (await staff("GET", "/reports/financial?from=2026-03-01&to=2026-03-31")).body;
    expect(march.totals).toMatchObject({ invoicedCents: 100_000, collectedCents: 100_000, refundedCents: 0 });
    const april = (await staff("GET", "/reports/financial?from=2026-04-01&to=2026-04-30")).body;
    expect(april.totals).toMatchObject({ invoicedCents: 0, collectedCents: 0, refundedCents: 20_000, netCollectedCents: -20_000 });
    expect(april.byMonth[0]).toMatchObject({ refundedCents: 20_000 });
  });

  it("lists unpaid invoices most overdue first, using the earliest unpaid due date", async () => {
    const sched = (due: string) => [{ label: "Deposit", amountCents: 20_000 }, { label: "Balance", amountCents: 80_000, dueDate: due }];
    await invoice({ cents: 100_000, issued: "2026-01-01", paid: [{ cents: 20_000, on: "2026-01-02" }], schedule: sched("2026-02-01") });
    await invoice({ cents: 50_000, issued: "2026-01-01", schedule: [{ label: "Balance", amountCents: 50_000, dueDate: "2999-01-01" }] });
    const r = (await staff("GET", "/reports/financial?from=2026-01-01&to=2026-01-31")).body;
    expect(r.outstanding.count).toBe(2);
    expect(r.outstanding.rows[0]).toMatchObject({ balanceCents: 80_000, dueOn: "2026-02-01" });
    expect(r.outstanding.rows[0].daysOverdue).toBeGreaterThan(0);
    expect(r.outstanding.rows[1]).toMatchObject({ dueOn: "2999-01-01", daysOverdue: 0 });
    expect(r.outstanding.overdueCents).toBe(80_000);
  });

  it("is owner only and checks the dates", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/reports/financial" })).statusCode).toBe(401);
    expect((await staff("GET", "/reports/financial?from=2026-05-01&to=2026-04-01")).status).toBe(400);
    expect((await staff("GET", "/reports/financial?from=nope")).status).toBe(400);
    expect((await staff("GET", "/reports/financial?from=2000-01-01&to=2026-01-01")).status).toBe(400);
    expect((await staff("GET", "/reports/financial")).status).toBe(200);
  });

  it("exports payments as CSV that a spreadsheet won't run as a formula", async () => {
    const id = await invoice({ cents: 10_000, issued: "2026-06-01", paid: [{ cents: 10_000, on: "2026-06-02", method: "venmo" }] });
    void id;
    const r = await app.inject({ method: "GET", url: "/api/studio/reports/payments.csv?from=2026-06-01&to=2026-06-30", headers: { cookie } });
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toContain("payments-2026-06-01-to-2026-06-30.csv");
    expect(r.body).toContain('"2026-06-02","Invoice 1001","Jane Smith","venmo","100.00"');
    expect(toCsv([["=cmd|' /C calc'!A0", 5], ['say "hi"', -2]])).toBe(`"'=cmd|' /C calc'!A0","5"\r\n"say ""hi""","-2"\r\n`);
  });
});
