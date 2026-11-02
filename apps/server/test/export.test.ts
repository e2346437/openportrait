import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { parseCsv } from "../src/import/csv.js";

let app: FastifyInstance;
let cookie: string;
let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-export-"));
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

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });

describe("data export", () => {
  it("requires sign-in and rejects unknown names", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/export/contacts.csv" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/studio/export/secrets.csv", headers: { cookie } })).statusCode).toBe(404);
  });

  it("exports clients as CSV that imports back without duplicates, and neutralises formulas", async () => {
    await post("/import/commit", { kind: "contacts", text: "First Name,Last Name,Email,Tags\nAda,Lovelace,ada@example.com,vip;family\n=cmd(),Evil,evil@example.com,\n" });
    const res = await app.inject({ method: "GET", url: "/api/studio/export/contacts.csv", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const table = parseCsv(res.body);
    expect(table.rows).toHaveLength(2);
    const ada = table.rows.find((r) => r["Last Name"] === "Lovelace")!;
    expect(ada["Email"]).toBe("ada@example.com");
    expect(ada["Tags"]).toBe("family; vip");
    expect(table.rows.find((r) => r["Last Name"] === "Evil")!["First Name"]).toBe("'=cmd()");

    const again = (await post("/import/commit", { kind: "contacts", text: res.body })).json();
    expect(again.created.contacts).toBe(0);
  });

  it("exports shoots and invoices with headers the importer understands", async () => {
    await post("/import/commit", { kind: "contacts", text: "First Name,Last Name,Email\nAda,Lovelace,ada@example.com\n" });
    await post("/import/commit", { kind: "shoots", text: "Shoot Name,Shoot Date,Shoot Type,Email\nAda portraits,2026-05-04,Portrait,ada@example.com\n" });
    await post("/import/commit", { kind: "invoices", text: "Order Number,Email,Total,Paid On,Amount,Payment Method\n1001,ada@example.com,300,2026-05-05,100,check\n1001,ada@example.com,300,2026-05-20,200,card\n" });

    const shoots = parseCsv((await app.inject({ method: "GET", url: "/api/studio/export/shoots.csv", headers: { cookie } })).body);
    expect(shoots.rows).toHaveLength(1);
    expect(shoots.rows[0]).toMatchObject({ "Shoot Name": "Ada portraits", "Shoot Date": "2026-05-04", "Shoot Type": "Portrait", Email: "ada@example.com" });

    const invoices = parseCsv((await app.inject({ method: "GET", url: "/api/studio/export/invoices.csv", headers: { cookie } })).body);
    expect(invoices.rows).toHaveLength(2);
    expect(invoices.rows.map((r) => r["Amount"])).toEqual(["100.00", "200.00"]);
    expect(invoices.rows[0]!["Total"]).toBe("300.00");
  });
});
