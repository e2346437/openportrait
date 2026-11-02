import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let root: string;
let cookie: string;

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const res = await app.inject({ method, url: `/api/studio${url}`, headers: { cookie }, payload: payload as object | undefined });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
const H = 3600000;
const T0 = Date.UTC(2027, 0, 10, 0, 0, 0);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-cal-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "T", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function makeShoot(startsAt: number, endsAt: number) {
  const c = (await call("POST", "/contacts", { firstName: "Ana", lastName: "Ruiz", email: "ana@example.com" })).body;
  const types = (await call("GET", "/shoot-types")).body.types;
  const r = await call("POST", "/shoots", { primaryContactId: c.id, shootTypeId: types[0].id, events: [{ startsAt, endsAt, location: "Park" }] });
  return { contact: c, shoot: r.body.shoot };
}

describe("calendar", () => {
  it("merges shoot times, appointments and blocks in start order", async () => {
    await makeShoot(T0 + 10 * H, T0 + 12 * H);
    await call("POST", "/calendar/entries", { kind: "appointment", title: "Consult call", startsAt: T0 + 8 * H, endsAt: T0 + 9 * H });
    await call("POST", "/calendar/entries", { kind: "block", title: "School run", startsAt: T0 + 14 * H, endsAt: T0 + 15 * H });
    const { body } = await call("GET", `/calendar?from=${T0}&to=${T0 + 24 * H}`);
    expect(body.items.map((i: { source: string }) => i.source)).toEqual(["appointment", "shoot", "block"]);
    expect(body.items[1].contactName).toBe("Ana Ruiz");
  });

  it("leaves out cancelled shoots and items outside the range", async () => {
    const { shoot } = await makeShoot(T0 + 10 * H, T0 + 12 * H);
    await call("POST", "/calendar/entries", { kind: "block", title: "Later", startsAt: T0 + 48 * H, endsAt: T0 + 49 * H });
    await call("PATCH", `/shoots/${shoot.id}`, { status: "cancelled" });
    const { body } = await call("GET", `/calendar?from=${T0}&to=${T0 + 24 * H}`);
    expect(body.items).toEqual([]);
  });

  it("validates entries and ranges", async () => {
    expect((await call("POST", "/calendar/entries", { kind: "block", title: "x", startsAt: T0 + H, endsAt: T0 })).status).toBe(400);
    expect((await call("POST", "/calendar/entries", { kind: "block", title: " ", startsAt: T0, endsAt: T0 + H })).status).toBe(400);
    expect((await call("GET", `/calendar?from=${T0}&to=${T0 + 800 * 86400000}`)).status).toBe(400);
    expect((await call("GET", `/calendar?from=${T0}&to=${T0}`)).status).toBe(400);
  });

  it("updates and deletes entries", async () => {
    const e = (await call("POST", "/calendar/entries", { kind: "block", title: "Away", startsAt: T0, endsAt: T0 + H })).body;
    const u = await call("PATCH", `/calendar/entries/${e.id}`, { title: "Away (trip)", endsAt: T0 + 2 * H });
    expect(u.body.title).toBe("Away (trip)");
    expect(new Date(u.body.endsAt).getTime()).toBe(T0 + 2 * H);
    expect((await call("DELETE", `/calendar/entries/${e.id}`)).status).toBe(200);
    expect((await call("GET", `/calendar/entries/${e.id}`)).status).toBe(404);
  });

  it("finds free time around everything that is busy", async () => {
    await makeShoot(T0 + 10 * H, T0 + 12 * H);
    await call("POST", "/calendar/entries", { kind: "block", title: "Lunch", startsAt: T0 + 11 * H, endsAt: T0 + 13 * H });
    const { body } = await call("GET", `/calendar/free?from=${T0 + 9 * H}&to=${T0 + 16 * H}&minutes=60`);
    expect(body.slots).toEqual([
      { startsAt: T0 + 9 * H, endsAt: T0 + 10 * H },
      { startsAt: T0 + 13 * H, endsAt: T0 + 16 * H },
    ]);
  });
});

describe("google settings api", () => {
  it("is owner only, refuses to connect without credentials, and saves the client", async () => {
    const status = await call("GET", "/google");
    expect(status.body).toMatchObject({ configured: false, connected: false });
    expect((await call("POST", "/google/connect")).status).toBe(400);
    expect((await call("PUT", "/google/client", { clientId: "123456789012-abc.apps.googleusercontent.com" })).status).toBe(400); // no secret yet
    expect((await call("PUT", "/google/client", { clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" })).status).toBe(200);
    const after = (await call("GET", "/google")).body;
    expect(after).toMatchObject({ configured: true, connected: false, hasSecret: true });
    expect(JSON.stringify(after)).not.toContain("GOCSPX");
  });

  it("builds a Google sign-in link once a public address is set, and rejects a callback with a bad state", async () => {
    await call("PUT", "/google/client", { clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" });
    await app.inject({ method: "PUT", url: "/api/studio/internet/public-url", headers: { cookie }, payload: { url: "https://studio.example.com" } });
    const { body, status } = await call("POST", "/google/connect");
    expect(status).toBe(200);
    const url = new URL(body.url);
    expect(url.searchParams.get("redirect_uri")).toBe("https://studio.example.com/api/studio/google/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const res = await app.inject({ method: "GET", url: "/api/studio/google/callback?code=x&state=wrong", headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("google_error=");
  });
});
