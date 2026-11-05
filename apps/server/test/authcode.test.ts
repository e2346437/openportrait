import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { checkCode, codeProblem, normalizeCode, suggestCode, setCode } from "../src/ai/authcode.js";

let app: FastifyInstance;
let cookie: string;
const PW = "correct horse battery";
beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-code-"));
  app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") }), startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Studio", ownerName: "Pat", email: "pat@example.com", password: PW, timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
});

describe("authorization code", () => {
  it("suggests the number plus two words shape", () => {
    for (let i = 0; i < 20; i++) expect(suggestCode()).toMatch(/^[1-9]\d [A-Z][a-z]+ [A-Z][a-z]+$/);
  });
  it("treats spoken and typed forms alike", () => {
    expect(normalizeCode("47 Alpha-Tango")).toBe("47 alpha tango");
    expect(normalizeCode("  047,  ALPHA   tango ")).toBe("47 alpha tango");
    expect(codeProblem("ab 1")).toBeTruthy();
  });
  it("stores only a hash and accepts the right code", async () => {
    await setCode(app.ctx, "47 Alpha Tango");
    expect(app.ctx.settings.get("ai.authCodeHash")).not.toContain("alpha");
    expect((await checkCode(app.ctx, "c1", "47 alpha tango")).ok).toBe(true);
    expect((await checkCode(app.ctx, "c1", "37 Gamma Echo")).ok).toBe(false);
    expect((await checkCode(app.ctx, "c1", undefined)).ok).toBe(false);
  });
  it("locks a connection after five wrong tries", async () => {
    await setCode(app.ctx, "47 Alpha Tango");
    for (let i = 0; i < 5; i++) await checkCode(app.ctx, "c2", "wrong code here");
    const r = await checkCode(app.ctx, "c2", "47 Alpha Tango");
    expect(r).toMatchObject({ ok: false, reason: "locked" });
    expect((await checkCode(app.ctx, "c3", "47 Alpha Tango")).ok).toBe(true);
  });
  it("refuses when no code is set", async () => {
    expect(await checkCode(app.ctx, "c4", "47 Alpha Tango")).toMatchObject({ ok: false, reason: "not_set" });
  });
  it("sets through the API, never returns it, and needs the password to change it", async () => {
    const s = await app.inject({ method: "GET", url: "/api/studio/ai/auth-code/suggest", headers: { cookie } });
    expect(s.json().code).toBeTruthy();
    const put = await app.inject({ method: "PUT", url: "/api/studio/ai/auth-code", payload: { code: "37 Gamma Echo" }, headers: { cookie } });
    expect(put.statusCode).toBe(200);
    expect(put.json().authCode.set).toBe(true);
    expect(JSON.stringify(put.json())).not.toMatch(/gamma/i);
    const bad = await app.inject({ method: "PUT", url: "/api/studio/ai/auth-code", payload: { code: "12 Delta Echo" }, headers: { cookie } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/studio/ai/auth-code", payload: { code: "12 Delta Echo", password: PW }, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: "/api/studio/ai/auth-code", payload: { password: PW }, headers: { cookie } });
    expect(del.json().authCode.set).toBe(false);
  });
});

describe("sensitive tool over MCP", () => {
  const api = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url: `/api/studio/ai${url}`, payload, headers: { cookie } });
  const call = async (token: string, args: object) => {
    const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "studio_set_automation_mode", arguments: args } }, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` } });
    const r = res.json().result;
    return { isError: !!r.isError, text: r.content[0].text as string };
  };
  it("asks for the code, runs with it, and keeps it out of the audit log", async () => {
    await api("PUT", "/", { enabled: true });
    const token = (await api("POST", "/connections", { label: "Claude", level: "full", areas: ["studio"] })).json().token as string;
    expect((await call(token, { mode: "ai" })).text).toMatch(/no is set|none is set/);
    await api("PUT", "/auth-code", { code: "47 Alpha Tango" });
    expect((await call(token, { mode: "ai" })).text).toMatch(/Authorization required/);
    expect(app.ctx.settings.get("automation.mode") ?? "built-in").toBe("built-in");
    const ok = await call(token, { mode: "ai", authCode: "47 alpha tango" });
    expect(ok.isError).toBe(false);
    expect(app.ctx.settings.get("automation.mode")).toBe("ai");
    const rows = app.ctx.db.select().from((await import("@openportrait/db")).tables.auditLog).all();
    expect(JSON.stringify(rows)).not.toMatch(/alpha/i);
  });
});
