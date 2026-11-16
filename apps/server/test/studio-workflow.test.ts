import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";
import { atTime, addDays, weekdayOf, ymdIn } from "../src/domain/time.js";

/**
 * One representative studio week with synthetic data, end to end over the API: a client books a session on a booking
 * page, the owner confirms it, quotes it, the client accepts, the owner records offline payments, and the financial
 * report adds up. Then the server restarts on the same data folder and everything is still there. Nothing here leaves
 * the machine: outgoing email goes to a fake transport.
 */

const TZ = "America/Chicago";
const owner = { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: TZ };
let apps: FastifyInstance[] = [];
let root: string;

afterEach(async () => {
  setTransportFactory(null);
  for (const a of apps) await a.close();
  apps = [];
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function boot() {
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  const app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  apps.push(app);
  return app;
}

const monday = () => {
  let d = addDays(ymdIn(Date.now(), TZ), 10);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
};

describe("a studio week, then a restart", () => {
  it("runs from booking to a financial report, and survives a restart with no extensions installed", async () => {
    setTransportFactory(() => ({ sendMail: async () => ({}) as never }));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "op-workflow-"));
    // Fresh install: no extensions folder at all, and setup is still to do.
    expect(fs.existsSync(path.join(root, "config", "extensions"))).toBe(false);
    let app = await boot();
    expect((await app.inject("/api/studio/setup")).json().needsSetup).toBe(true);
    const setup = await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner });
    expect(setup.statusCode).toBeLessThan(300);
    let cookie = `op_session=${setup.cookies.find((c) => c.name === "op_session")!.value}`;
    app.ctx.settings.set("studio.email", "owner@example.com");

    const staff = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
      return { status: r.statusCode, body: r.body ? r.json() : null };
    };
    const pub = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/public${url}`, payload: payload as object });
      return { status: r.statusCode, body: r.body ? r.json() : null };
    };

    // A booking page that makes a shoot, and a client who books it.
    const typeId = (await staff("GET", "/shoot-types")).body.types[0].id as string;
    const page = (await staff("POST", "/schedulers", { name: "Mini session", durationMinutes: 60, stepMinutes: 60, minNoticeHours: 0, availability: { "1": [{ start: "09:00", end: "12:00" }] }, shootTypeId: typeId, createShoot: true })).body;
    const booked = await pub("POST", `/book/${page.slug}`, { firstName: "Ana", lastName: "Ruiz", email: "ana@example.test", startsAt: atTime(monday(), "10:00", TZ) });
    expect(booked.status).toBe(201);
    expect((await staff("GET", "/shoots")).body.items).toHaveLength(0); // waits for the owner
    expect((await staff("POST", `/bookings/${booked.body.id}/confirm`)).status).toBeLessThan(300);
    const shoot = (await staff("GET", "/shoots")).body.items[0] as { id: string; subject: string };
    expect(shoot.subject).toBe("Ana Ruiz");

    // The booking created the contact; quote the shoot to them, they accept, which makes the invoice.
    const contact = (await staff("GET", "/contacts?q=ruiz")).body.items[0] as { id: string };
    const quote = (await staff("POST", "/orders", { kind: "quote", contactId: contact.id, shootId: shoot.id, title: "Mini session", lines: [{ description: "Mini session", unitCents: 45_000, taxable: false }] })).body;
    expect((await staff("POST", `/orders/${quote.id}/send`)).status).toBeLessThan(300);
    expect((await pub("POST", `/order/${quote.token}/accept`, { name: "Ana Ruiz" })).status).toBe(200);

    // Offline payments: a deposit by check and the balance in cash.
    expect((await staff("POST", `/orders/${quote.id}/payments`, { amountCents: 15_000, method: "check" })).status).toBe(200);
    expect((await staff("POST", `/orders/${quote.id}/payments`, { amountCents: 30_000, method: "cash" })).status).toBe(200);
    const order = (await staff("GET", `/orders/${quote.id}`)).body;
    expect(order.paidCents).toBe(45_000);
    expect(order.balanceCents ?? 45_000 - order.paidCents).toBe(0);

    const report = async () => {
      const day = ymdIn(Date.now(), TZ);
      return (await staff("GET", `/reports/financial?from=${addDays(day, -1)}&to=${addDays(day, 1)}`)).body;
    };
    const before = await report();
    expect(before.totals).toMatchObject({ invoicedCents: 45_000, collectedCents: 45_000, invoiceCount: 1, paymentCount: 2 });
    expect(before.outstanding.count).toBe(0);
    expect(before.byMethod.map((m: { method: string }) => m.method).sort()).toEqual(["cash", "check"]);

    // Restart on the same data folder.
    await app.close();
    apps = [];
    app = await boot();
    expect((await app.inject("/api/studio/setup")).json().needsSetup).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/studio/setup", payload: { ...owner, email: "second@example.com" } })).statusCode).toBe(409);
    const login = await app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    cookie = `op_session=${login.cookies.find((c) => c.name === "op_session")!.value}`;

    expect((await staff("GET", "/shoots")).body.items.map((s: { subject: string }) => s.subject)).toEqual(["Ana Ruiz"]);
    expect((await staff("GET", `/orders/${quote.id}`)).body).toMatchObject({ id: quote.id, kind: "invoice", paidCents: 45_000 });
    expect(await report()).toEqual(before);
    expect(app.ctx.settings.get("studio.email")).toBe("owner@example.com");
    // The booked slot stays taken after the restart.
    const day = ymdIn(atTime(monday(), "10:00", TZ), TZ);
    const slots = (await pub("GET", `/book/${page.slug}/slots?from=${day}&to=${day}`)).body.days[day] as Array<{ startsAt: number }> | undefined;
    expect((slots ?? []).some((s) => s.startsAt === atTime(monday(), "10:00", TZ))).toBe(false);
  });
});
