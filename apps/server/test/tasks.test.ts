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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-tasks-"));
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




const typeId = async () => (await staff("GET", "/shoot-types")).body.types[0].id as string;
async function client() {
  return (await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
}
async function makeShoot(events: object[] = [{ title: "Ceremony", startsAt: Date.UTC(2027, 5, 12, 20), endsAt: Date.UTC(2027, 5, 12, 22) }]) {
  return (await staff("POST", "/shoots", { subject: "Smith wedding", shootTypeId: await typeId(), primaryContactId: await client(), events })).body.shoot.id as string;
}

describe("shoot tasks", () => {
  it("adds, ticks off, edits and deletes tasks on a shoot", async () => {
    const shoot = await makeShoot();
    const a = await staff("POST", `/shoots/${shoot}/tasks`, { title: "Edit the gallery", dueDate: "2027-06-20" });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ title: "Edit the gallery", dueDate: "2027-06-20", done: false });
    expect((await staff("POST", `/shoots/${shoot}/tasks`, { title: "  " })).body.message).toMatch(/name/);
    expect((await staff("POST", `/shoots/${shoot}/tasks`, { title: "X", dueDate: "June 20" })).body.message).toMatch(/due date/);
    expect((await staff("PATCH", `/tasks/${a.body.id}`, { done: true })).body.done).toBe(true);
    expect((await staff("GET", `/tasks`)).body.items).toHaveLength(0); // open only by default
    expect((await staff("GET", `/tasks?status=done`)).body.items.map((t: { title: string }) => t.title)).toEqual(["Edit the gallery"]);
    await staff("PATCH", `/tasks/${a.body.id}`, { done: false, title: "Edit and deliver" });
    expect((await staff("GET", `/shoots/${shoot}/tasks`)).body.items[0]).toMatchObject({ title: "Edit and deliver", done: false });
    expect((await staff("DELETE", `/tasks/${a.body.id}`)).status).toBe(200);
    expect((await staff("GET", `/shoots/${shoot}/tasks`)).body.items).toEqual([]);
  });

  it("lists across shoots soonest first with undated last, flags overdue, and hides cancelled shoots", async () => {
    const one = await makeShoot();
    const two = await makeShoot();
    await staff("POST", `/shoots/${one}/tasks`, { title: "Later", dueDate: "2099-01-02" });
    await staff("POST", `/shoots/${one}/tasks`, { title: "No date" });
    await staff("POST", `/shoots/${two}/tasks`, { title: "Long ago", dueDate: "2020-01-01" });
    const list = (await staff("GET", "/tasks")).body.items as Array<{ title: string; overdue: boolean; shoot: { subject: string } }>;
    expect(list.map((t) => t.title)).toEqual(["Long ago", "Later", "No date"]);
    expect(list[0]).toMatchObject({ overdue: true, shoot: { subject: "Smith wedding" } });
    expect((await staff("GET", "/tasks?dueBy=2030-01-01")).body.items.map((t: { title: string }) => t.title)).toEqual(["Long ago"]);
    await staff("PATCH", `/shoots/${two}`, { status: "cancelled" });
    expect((await staff("GET", "/tasks")).body.items.map((t: { title: string }) => t.title)).toEqual(["Later", "No date"]);
  });

  it("copies a type's checklist onto new shoots, counting days from the first date", async () => {
    const type = await typeId();
    const set = await staff("PUT", `/shoot-types/${type}/tasks`, { items: [{ title: "Send questionnaire", dueDays: -14 }, { title: "Deliver gallery", dueDays: 14 }, { title: "Ask for a review" }] });
    expect(set.body.items).toHaveLength(3);
    const shoot = await makeShoot();
    const tasks = (await staff("GET", `/shoots/${shoot}/tasks`)).body.items as Array<{ title: string; dueDate: string | null }>;
    expect(tasks.map((t) => [t.title, t.dueDate])).toEqual([["Send questionnaire", "2027-05-29"], ["Deliver gallery", "2027-06-26"], ["Ask for a review", null]]);
    // A shoot with no date yet gets the tasks without due dates.
    const undated = await makeShoot([]);
    expect((await staff("GET", `/shoots/${undated}/tasks`)).body.items.every((t: { dueDate: string | null }) => t.dueDate === null)).toBe(true);
    // Replacing the checklist doesn't touch shoots that already exist.
    await staff("PUT", `/shoot-types/${type}/tasks`, { items: [] });
    expect((await staff("GET", `/shoots/${shoot}/tasks`)).body.items).toHaveLength(3);
    expect((await staff("PUT", `/shoot-types/${type}/tasks`, { items: [{ title: "" }] })).status).toBe(400);
  });

  it("logs a finished task on the client's timeline", async () => {
    const shoot = await makeShoot();
    const t = (await staff("POST", `/shoots/${shoot}/tasks`, { title: "Cull images" })).body;
    await staff("PATCH", `/tasks/${t.id}`, { done: true });
    const row = app.ctx.db.$client.prepare("select summary from activity where kind = 'task.done'").get() as { summary: string } | undefined;
    expect(row?.summary).toBe("Done: Cull images");
  });
});
