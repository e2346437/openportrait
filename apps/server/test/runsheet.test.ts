import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let cookie: string;
let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-run-"));
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

const staff = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
async function makeShoot() {
  const type = (await staff("GET", "/shoot-types")).body.types[0].id as string;
  const contact = (await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
  return (await staff("POST", "/shoots", { subject: "Smith wedding", shootTypeId: type, primaryContactId: contact })).body.shoot.id as string;
}

describe("shoot run sheet", () => {
  it("lists lines in time order and supports edit and delete", async () => {
    const id = await makeShoot();
    expect((await staff("GET", `/shoots/${id}/run-sheet`)).body.items).toEqual([]);
    const late = await staff("POST", `/shoots/${id}/run-sheet`, { startMinutes: 17 * 60 + 30, durationMinutes: 45, title: "Golden hour portraits", location: "The pier", notes: "Bring the 85mm" });
    expect(late.status).toBe(201);
    await staff("POST", `/shoots/${id}/run-sheet`, { startMinutes: 9 * 60, title: "Getting ready" });
    const list = (await staff("GET", `/shoots/${id}/run-sheet`)).body.items;
    expect(list.map((i: { title: string }) => i.title)).toEqual(["Getting ready", "Golden hour portraits"]);
    expect(list[1]).toMatchObject({ durationMinutes: 45, location: "The pier", notes: "Bring the 85mm" });

    const patched = await staff("PATCH", `/shoots/${id}/run-sheet/${late.body.id}`, { startMinutes: 8 * 60, durationMinutes: null });
    expect(patched.body).toMatchObject({ startMinutes: 480, durationMinutes: null, title: "Golden hour portraits" });
    expect((await staff("DELETE", `/shoots/${id}/run-sheet/${late.body.id}`)).status).toBe(200);
    expect((await staff("GET", `/shoots/${id}/run-sheet`)).body.items).toHaveLength(1);
  });

  it("rejects bad input and unknown shoots or lines", async () => {
    const id = await makeShoot();
    expect((await staff("POST", `/shoots/${id}/run-sheet`, { startMinutes: 600, title: "  " })).status).toBe(400);
    expect((await staff("POST", `/shoots/${id}/run-sheet`, { startMinutes: 2000, title: "x" })).status).toBe(400);
    expect((await staff("GET", "/shoots/nope/run-sheet")).status).toBe(404);
    expect((await staff("PATCH", `/shoots/${id}/run-sheet/nope`, { title: "x" })).status).toBe(404);
  });

  it("won't touch another shoot's line and is removed with its shoot", async () => {
    const a = await makeShoot();
    const b = await makeShoot();
    const line = (await staff("POST", `/shoots/${a}/run-sheet`, { startMinutes: 600, title: "Arrive" })).body.id;
    expect((await staff("PATCH", `/shoots/${b}/run-sheet/${line}`, { title: "x" })).status).toBe(404);
    expect((await staff("DELETE", `/shoots/${b}/run-sheet/${line}`)).status).toBe(404);
  });

  it("needs a signed-in user", async () => {
    const r = await app.inject({ method: "GET", url: "/api/studio/shoots/x/run-sheet" });
    expect(r.statusCode).toBe(401);
  });
});
