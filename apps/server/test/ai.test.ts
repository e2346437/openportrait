import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { defineTool } from "../src/ai/registry.js";
import { buildApp } from "../src/app.js";

defineTool({ name: "contacts_test_read", title: "t", description: "t", area: "contacts", tier: "read", input: {}, handler: () => "ok" });
defineTool({ name: "contacts_test_draft", title: "t", description: "t", area: "contacts", tier: "draft", input: {}, handler: () => "ok" });

let app: FastifyInstance;
let cookie: string;

const owner = { studioName: "Test Studio", ownerName: "Pat Doe", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" };

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-ai-"));
  app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") }), startBackground: false, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner });
  const c = res.cookies.find((c) => c.name === "op_session")!;
  cookie = `op_session=${c.value}`;
});
afterEach(async () => {
  await app.close();
});

const api = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url: `/api/studio/ai${url}`, payload: payload as object, headers: { cookie } });
const rpc = (token: string | null, body: unknown) =>
  app.inject({
    method: "POST",
    url: "/mcp",
    payload: body as object,
    headers: { accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
const call = (token: string, name: string, args: object = {}) => rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

async function connect(level: "read" | "assist" | "full" = "read", areas = ["studio"]) {
  const res = await api("POST", "/connections", { label: "Claude test", level, areas });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

describe("MCP endpoint", () => {
  it("does not exist until the owner turns it on", async () => {
    expect((await rpc("opai_x", { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(404);
  });

  it("rejects missing and unknown tokens once enabled", async () => {
    await api("PUT", "/", { enabled: true });
    const none = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toContain("Bearer");
    expect((await rpc("opai_nope", { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(401);
  });

  it("lists tools and runs one, and records it in the activity log", async () => {
    await api("PUT", "/", { enabled: true });
    const token = await connect();
    const list = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.statusCode).toBe(200);
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toContain("studio_get_summary");
    const res = await call(token, "studio_get_summary");
    const text = res.json().result.content[0].text as string;
    expect(JSON.parse(text)).toMatchObject({ studio: "Test Studio", timezone: "America/Chicago" });
    const activity = (await api("GET", "/activity")).json();
    expect(activity.items[0]).toMatchObject({ connection: "Claude test", action: "studio_get_summary", ok: true });
    expect((await api("GET", "/")).json().lastSeenAt).toBeGreaterThan(0);
  });

  it("only offers tools in the connection's allowed areas and tiers", async () => {
    await api("PUT", "/", { enabled: true });
    const names = async (level: "read" | "assist", areas: string[]) => {
      const res = await rpc(await connect(level, areas), { jsonrpc: "2.0", id: 1, method: "tools/list" });
      return res.json().result.tools.map((t: { name: string }) => t.name).sort();
    };
    expect(await names("read", ["studio"])).toEqual(["studio_get_summary", "studio_whoami"]);
    expect(await names("read", ["studio", "contacts"])).toEqual(["contacts_test_read", "studio_get_summary", "studio_whoami"]);
    expect(await names("assist", ["contacts"])).toEqual(["contacts_test_draft", "contacts_test_read"]);
  });

  it("will not run a tool the connection can't see", async () => {
    await api("PUT", "/", { enabled: true });
    const token = await connect("read", ["studio"]);
    const res = await call(token, "contacts_test_draft");
    expect(JSON.stringify(res.json())).toMatch(/not found|disabled|Unknown|error/i);
    expect(res.json().result?.content?.[0]?.text ?? "").not.toBe("ok");
  });

  it("stops working when paused or revoked", async () => {
    await api("PUT", "/", { enabled: true });
    const res = await api("POST", "/connections", { label: "Temp", level: "read", areas: ["studio"] });
    const { token, connection } = res.json();
    await api("PUT", "/", { paused: true });
    expect((await call(token, "studio_get_summary")).statusCode).toBe(503);
    await api("PUT", "/", { paused: false });
    expect((await call(token, "studio_get_summary")).statusCode).toBe(200);
    await api("DELETE", `/connections/${connection.id}`);
    expect((await call(token, "studio_get_summary")).statusCode).toBe(401);
  });

  it("refuses an expired token", async () => {
    await api("PUT", "/", { enabled: true });
    const token = await connect();
    app.ctx.db.$client.prepare("UPDATE ai_connection SET expires_at = 1").run();
    expect((await call(token, "studio_get_summary")).statusCode).toBe(401);
  });

  it("never stores the token itself", async () => {
    const token = await connect();
    const rows = app.ctx.db.$client.prepare("SELECT token_hash, token_hint FROM ai_connection").all() as Array<{ token_hash: string; token_hint: string }>;
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hint).toBe(token.slice(-4));
  });
});

describe("AI settings API", () => {
  it("requires the owner and validates input", async () => {
    expect((await app.inject("/api/studio/ai")).statusCode).toBe(401);
    expect((await api("POST", "/connections", { label: "", level: "read", areas: ["studio"] })).statusCode).toBe(400);
    expect((await api("POST", "/connections", { label: "x", level: "read", areas: [] })).statusCode).toBe(400);
  });
});
