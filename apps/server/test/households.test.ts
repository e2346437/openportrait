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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-households-"));
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




const person = async (firstName: string, lastName: string, email: string) => (await staff("POST", "/contacts", { firstName, lastName, email })).body.id as string;
const detail = async (id: string) => (await staff("GET", `/contacts/${id}`)).body;

describe("households", () => {
  it("joins two people into a household named after them, and shows each the other", async () => {
    const emma = await person("Emma", "Smith", "emma@example.com");
    const liam = await person("Liam", "Smith", "liam@example.com");
    expect((await detail(emma)).household).toBeNull();
    const r = await staff("PUT", `/contacts/${liam}/household`, { withContactId: emma });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Smith household");
    expect(r.body.members.map((m: { name: string }) => m.name).sort()).toEqual(["Emma Smith", "Liam Smith"]);
    const e = await detail(emma);
    expect(e.household.members.map((m: { name: string }) => m.name)).toEqual(["Liam Smith"]);
    expect((await detail(liam)).household.id).toBe(e.household.id);
  });

  it("adds a third person to the existing household, and refuses joining yourself", async () => {
    const a = await person("Emma", "Smith", "a@example.com");
    const b = await person("Liam", "Smith", "b@example.com");
    const c = await person("Noah", "Smith", "c@example.com");
    await staff("PUT", `/contacts/${b}/household`, { withContactId: a });
    const r = await staff("PUT", `/contacts/${c}/household`, { withContactId: b });
    expect(r.body.members).toHaveLength(3);
    expect((await staff("PUT", `/contacts/${a}/household`, { withContactId: a })).status).toBe(400);
    expect((await staff("PUT", `/contacts/${a}/household`, { withContactId: "nope" })).status).toBe(404);
  });

  it("renames a household, and removes one when its last member leaves", async () => {
    const a = await person("Emma", "Smith", "a@example.com");
    const b = await person("Liam", "Smith", "b@example.com");
    const h = (await staff("PUT", `/contacts/${b}/household`, { withContactId: a })).body;
    expect((await staff("PATCH", `/households/${h.id}`, { name: "The Smiths" })).body.name).toBe("The Smiths");
    expect((await staff("PATCH", `/households/${h.id}`, { name: " " })).status).toBe(400);
    await staff("DELETE", `/contacts/${a}/household`);
    expect((await detail(a)).household).toBeNull();
    expect((await staff("GET", `/households/${h.id}`)).body.members).toHaveLength(1);
    await staff("DELETE", `/contacts/${b}/household`);
    expect((await staff("GET", `/households/${h.id}`)).status).toBe(404);
  });

  it("moving to another household leaves the old one if it still has people", async () => {
    const a = await person("A", "One", "a@example.com");
    const b = await person("B", "One", "b@example.com");
    const c = await person("C", "Two", "c@example.com");
    const d = await person("D", "Two", "d@example.com");
    const one = (await staff("PUT", `/contacts/${b}/household`, { withContactId: a })).body;
    const two = (await staff("PUT", `/contacts/${d}/household`, { withContactId: c })).body;
    await staff("PUT", `/contacts/${b}/household`, { withContactId: c });
    expect((await staff("GET", `/households/${one.id}`)).body.members).toHaveLength(1);
    expect((await staff("GET", `/households/${two.id}`)).body.members).toHaveLength(3);
  });
});
