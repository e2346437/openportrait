import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { parseCsv } from "../src/import/csv.js";
import { parseMoneyCents, parseYmd } from "../src/import/fields.js";

let app: FastifyInstance;
let cookie: string;
let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-import-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};

const CONTACTS = `First Name,Last Name,Company,Email,Phone (Primary),State/Prov,Zip/Postal Code
Ada,Lovelace,,ADA@example.com,555-0100,IN,46201
"Grace ""Amazing""",Hopper,"Navy, Inc.",grace@example.com,,ME,04101
,,,,,,
Nameless,,,not-an-email,,,
`;

describe("import helpers", () => {
  it("parses quoted CSV", () => {
    const t = parseCsv(CONTACTS);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[1]!["First Name"]).toBe('Grace "Amazing"');
    expect(t.rows[1]!.Company).toBe("Navy, Inc.");
  });
  it("reads money and dates", () => {
    expect(parseMoneyCents("$1,234.50")).toBe(123450);
    expect(parseMoneyCents("(25.00)")).toBe(-2500);
    expect(parseMoneyCents("1.234,50")).toBe(123450);
    expect(parseYmd("3/4/2026")).toBe("2026-03-04");
    expect(parseYmd("2026-13-40")).toBeNull();
  });
});

describe("import", () => {
  it("previews without writing, then imports and doesn't duplicate", async () => {
    const preview = await call("POST", "/import/preview", { kind: "contacts", text: CONTACTS });
    expect(preview.status).toBe(200);
    expect(preview.body.mapping.firstName).toBe("First Name");
    expect(preview.body.mapping.phone).toBe("Phone (Primary)");
    expect(preview.body.counts).toMatchObject({ create: 2, error: 1 });
    expect((await call("GET", "/contacts")).body.total).toBe(0);

    const run = await call("POST", "/import/commit", { kind: "contacts", text: CONTACTS });
    expect(run.body.created.contacts).toBe(2);
    const list = (await call("GET", "/contacts")).body;
    expect(list.total).toBe(2);
    expect(list.items.find((c: { email: string }) => c.email === "ada@example.com")).toBeTruthy();

    const again = await call("POST", "/import/commit", { kind: "contacts", text: CONTACTS });
    expect(again.body.counts.create).toBe(0);
    expect((await call("GET", "/contacts")).body.total).toBe(2);
  });

  it("imports shoots, creating clients and shoot types", async () => {
    const csv = "Name,Date,Type,Status,First Name,Last Name,Email\nSmith Family,4/12/2026,Elopement,Booked,Sam,Smith,sam@example.com\nHeadshots,2026-05-01,Headshot,Complete,Sam,Smith,sam@example.com\n";
    const r = await call("POST", "/import/commit", { kind: "shoots", text: csv });
    expect(r.body.created).toMatchObject({ shoots: 2, contacts: 1, shootTypes: 1 });
    const shoots = (await call("GET", "/shoots")).body;
    expect(shoots.items.map((s: { subject: string }) => s.subject).sort()).toEqual(["Headshots", "Smith Family"]);
  });

  it("groups payment rows into invoices and adds late payments later", async () => {
    const one = "Order Number,Paid On,First Name,Last Name,Email,Payment Method,Amount,Attached\nSS-1,3/1/2026,Sam,Smith,sam@example.com,Venmo,$250.00,Smith Family\nSS-1,4/1/2026,Sam,Smith,sam@example.com,Check,$250.00,Smith Family\nSS-2,4/2/2026,Pat,Jones,pat@example.com,Credit Card,$100.00,\n";
    const r = await call("POST", "/import/commit", { kind: "invoices", text: one });
    expect(r.body.created).toMatchObject({ invoices: 2, payments: 3 });
    const orders = (await call("GET", "/orders?kind=invoice")).body;
    const ss1 = orders.items.find((o: { title: string }) => o.title === "Smith Family");
    expect(ss1.totalCents).toBe(50000);
    expect(ss1.state).toBe("paid");

    const two = one + "SS-2,5/1/2026,Pat,Jones,pat@example.com,Cash,$25.00,\n";
    const r2 = await call("POST", "/import/commit", { kind: "invoices", text: two });
    expect(r2.body.created).toMatchObject({ invoices: 0, payments: 1 });
    expect(r2.body.counts.update).toBe(1);
  });

  it("is owner only and refuses a bad mapping", async () => {
    expect((await app.inject({ method: "POST", url: "/api/studio/import/preview", payload: { kind: "contacts", text: "a\n1" } })).statusCode).toBe(401);
    const bad = await call("POST", "/import/preview", { kind: "shoots", text: "A,B\n1,2\n" });
    expect(bad.status).toBe(400);
  });
});
