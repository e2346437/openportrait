import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { builtInMayRun } from "../src/automation/registry.js";
import { createLead } from "../src/domain/leads.js";
import { createShoot } from "../src/domain/shoots.js";
import { listShootTypes } from "../src/domain/catalog.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let cookie: string;
let leadId: string;
let contactId: string;
const DAY = 86_400_000;

const svc = () => ({ db: app.ctx.db, settings: app.ctx.settings, config: app.ctx.config, actorId: null });

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-auto-"));
  app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") }), startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  await app.inject({ method: "PUT", url: "/api/studio/ai", payload: { enabled: true }, headers: { cookie } });
  const l = createLead(svc(), { contact: { firstName: "Dana", lastName: "Reyes", email: "dana@example.com" } });
  leadId = l.lead.id;
  contactId = l.lead.contactId;
  // An inquiry that arrived three days ago.
  app.ctx.db.$client.prepare("UPDATE lead SET created_at = ?, updated_at = ?").run(Date.now() - 3 * DAY, Date.now() - 3 * DAY);
});
afterEach(async () => {
  await app.close();
});

const api = (method: "GET" | "PUT", payload?: object) => app.inject({ method, url: "/api/studio/automation", payload, headers: { cookie } });
async function aiConnection() {
  return (await app.inject({ method: "POST", url: "/api/studio/ai/connections", payload: { label: "Claude", level: "read", areas: ["studio"] }, headers: { cookie } })).json().token as string;
}
const queue = async (token: string) => {
  const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "studio_get_work_queue", arguments: {} } }, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` } });
  return JSON.parse(res.json().result.content[0].text) as { mode: string; count: number; items: Array<{ id: string; automation: string; title: string }> };
};

describe("automation mode", () => {
  it("defaults to built-in schedulers and hands the AI nothing", async () => {
    const s = (await api("GET")).json();
    expect(s).toMatchObject({ mode: "built-in", queueSize: 0, stale: false });
    expect(s.automations.every((a: { owner: string }) => a.owner === "built-in")).toBe(true);
    expect(builtInMayRun(app.ctx.settings, "lead-first-reply")).toBe(true);
    expect((await queue(await aiConnection())).count).toBe(0);
  });

  it("built-in mode lists reminders for the owner, and the AI queue stays empty", async () => {
    const r = await app.inject({ url: "/api/studio/automation/reminders", headers: { cookie } });
    expect(r.json().items.map((i: { id: string }) => i.id)).toEqual([`lead-first-reply:${leadId}`]);
    expect((await api("GET")).json().automations.find((a: { id: string }) => a.id === "lead-first-reply")).toMatchObject({ reminders: 1, waiting: 0 });
    await api("PUT", { overrides: { "lead-first-reply": "off" } });
    expect((await app.inject({ url: "/api/studio/automation/reminders", headers: { cookie } })).json().items).toEqual([]);
    expect((await app.inject("/api/studio/automation/reminders")).statusCode).toBe(401);
  });

  it("AI-controlled mode gives the AI the work and silences the built-in rules", async () => {
    await api("PUT", { mode: "ai" });
    expect(builtInMayRun(app.ctx.settings, "lead-first-reply")).toBe(false);
    const q = await queue(await aiConnection());
    expect(q).toMatchObject({ mode: "ai", count: 1 });
    expect(q.items[0]).toMatchObject({ id: `lead-first-reply:${leadId}`, title: "Reply to Dana Reyes" });
  });

  it("lets one automation stay built-in or switch off while the rest go to the AI", async () => {
    await api("PUT", { mode: "ai", overrides: { "lead-first-reply": "built-in" } });
    expect(builtInMayRun(app.ctx.settings, "lead-first-reply")).toBe(true);
    expect((await queue(await aiConnection())).count).toBe(0);
    await api("PUT", { overrides: { "lead-first-reply": "off" } });
    expect(builtInMayRun(app.ctx.settings, "lead-first-reply")).toBe(false);
    expect((await queue(await aiConnection())).count).toBe(0);
    await api("PUT", { overrides: { "lead-first-reply": null } });
    expect((await queue(await aiConnection())).count).toBe(1);
  });

  it("can hand just one automation to the AI while the studio stays built-in", async () => {
    await api("PUT", { overrides: { "lead-first-reply": "ai" } });
    expect((await queue(await aiConnection())).count).toBe(1);
    expect((await api("GET")).json().mode).toBe("built-in");
  });

  it("warns, and does nothing else, when the AI hasn't checked in", async () => {
    await api("PUT", { mode: "ai" });
    expect((await api("GET")).json()).toMatchObject({ stale: true, queueSize: 1, lastCheckinAt: null });
    await queue(await aiConnection());
    expect((await api("GET")).json()).toMatchObject({ stale: false });
    app.ctx.settings.set("automation.lastAiCheckinAt", Date.now() - 25 * 3_600_000);
    expect((await api("GET")).json().stale).toBe(true);
    await api("PUT", { windowHours: 48 });
    expect((await api("GET")).json().stale).toBe(false);
  });

  it("finds upcoming shoots with no location, and stops once one is added", async () => {
    await api("PUT", { mode: "ai" });
    const type = listShootTypes(svc())[0]!;
    const { shoot } = createShoot(svc(), { primaryContactId: contactId, shootTypeId: type.id, subject: "Reyes family", events: [{ startsAt: Date.now() + 3 * DAY, endsAt: Date.now() + 3 * DAY + 3_600_000 }] });
    const token = await aiConnection();
    expect((await queue(token)).items.map((i) => i.id)).toContain(`shoot-prep:${shoot.id}`);
    app.ctx.db.$client.prepare("UPDATE shoot_event SET location = 'City Park' WHERE shoot_id = ?").run(shoot.id);
    expect((await queue(token)).items.map((i) => i.id)).not.toContain(`shoot-prep:${shoot.id}`);
  });

  it("validates input and is owner only", async () => {
    expect((await api("PUT", { overrides: { nope: "ai" } })).statusCode).toBe(400);
    expect((await api("PUT", { mode: "robots" as never })).statusCode).toBe(400);
    expect((await app.inject("/api/studio/automation")).statusCode).toBe(401);
  });
});
