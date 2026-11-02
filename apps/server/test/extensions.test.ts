import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { allTools, lockCapability, toolsFor } from "../src/ai/registry.js";

let app: FastifyInstance | undefined;
let root = "";

async function boot(files: Record<string, string>) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-ext-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(path.join(config.configDir, "extensions"), { recursive: true });
  for (const [name, code] of Object.entries(files)) fs.writeFileSync(path.join(config.configDir, "extensions", name), code);
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  return `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const caller = { level: "full" as const, areas: ["studio"] };

describe("extensions", () => {
  it("loads a module, mounts owner-only routes, and lists it", async () => {
    const cookie = await boot({
      "hello.mjs": `export function register(api) { api.settingsCard({ title: "Hello", status: { route: "/ping" }, actions: [] }); api.routes(async (r) => { r.get("/ping", async () => ({ pong: api.id })); }); }`,
    });
    expect((await app!.inject({ method: "GET", url: "/api/studio/extensions/hello/ping" })).statusCode).toBe(401);
    const ok = await app!.inject({ method: "GET", url: "/api/studio/extensions/hello/ping", headers: { cookie } });
    expect(ok.json()).toEqual({ pong: "hello" });
    const list = await app!.inject({ method: "GET", url: "/api/studio/extensions", headers: { cookie } });
    expect(list.json().extensions[0]).toMatchObject({ id: "hello", status: "loaded" });
    expect(list.json().extensions[0].cards[0].title).toBe("Hello");
    expect(list.json().extensions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists report sections an extension adds, and serves them to the owner only", async () => {
    const cookie = await boot({
      "rep.mjs": `export function register(api) { api.reportSection({ title: "Extra", route: "/extra" }); api.routes(async (r) => { r.get("/extra", async (req) => ({ stats: [{ label: "From", value: req.query.from }] })); }); }`,
    });
    const list = (await app!.inject({ method: "GET", url: "/api/studio/extensions", headers: { cookie } })).json().extensions[0];
    expect(list.reports).toEqual([{ title: "Extra", route: "/extra" }]);
    expect((await app!.inject({ method: "GET", url: "/api/studio/extensions/rep/extra?from=2026-01-01" })).statusCode).toBe(401);
    const r = await app!.inject({ method: "GET", url: "/api/studio/extensions/rep/extra?from=2026-01-01", headers: { cookie } });
    expect(r.json().stats[0]).toEqual({ label: "From", value: "2026-01-01" });
  });

  it("lists the pages a module adds and rejects a bad slug", async () => {
    const cookie = await boot({
      "pages.mjs": `export function register(api) {
        api.page({ slug: "things", title: "Things", icon: "receipt", group: "Books", list: { route: "/things", columns: [{ key: "name", label: "Name" }], empty: { title: "None", text: "Add one." } } });
        api.routes(async (r) => { r.get("/things", async () => ({ rows: [{ id: "1", name: "a" }], zod: typeof api.z.object })); });
      }`,
      "badpage.mjs": `export function register(api) { api.page({ slug: "Bad Slug", title: "x", list: { route: "/x", columns: [], empty: { title: "", text: "" } } }); }`,
    });
    const list = (await app!.inject({ method: "GET", url: "/api/studio/extensions", headers: { cookie } })).json().extensions as Array<{ id: string; status: string; pages: Array<{ slug: string; title: string; group: string }> }>;
    const ok = list.find((e) => e.id === "pages")!;
    expect(ok.pages).toMatchObject([{ slug: "things", title: "Things", group: "Books" }]);
    const bad = list.find((e) => e.id === "badpage")!;
    expect(bad.status).toBe("failed");
    expect(bad.pages).toEqual([]);
    const rows = await app!.inject({ method: "GET", url: "/api/studio/extensions/pages/things", headers: { cookie } });
    expect(rows.json()).toEqual({ rows: [{ id: "1", name: "a" }], zod: "function" });
  });

  it("skips a broken module and still boots", async () => {
    const cookie = await boot({ "bad.mjs": `throw new Error("nope");`, "empty.mjs": `export const x = 1;`, "good.mjs": `export function register() {}` });
    const list = (await app!.inject({ method: "GET", url: "/api/studio/extensions", headers: { cookie } })).json().extensions;
    expect(Object.fromEntries(list.map((e: { id: string; status: string }) => [e.id, e.status]))).toEqual({ bad: "failed", empty: "failed", good: "loaded" });
  });

  it("lets an extension grant and revoke a locked capability group", async () => {
    lockCapability("ext-test-group");
    const cookie = await boot({
      "grants.mjs": `export function register(api) {
        api.defineTool({ name: "studio_ext_test", title: "t", description: "t", area: "studio", tier: "read", capability: "ext-test-group", input: {}, handler: () => "ok" });
        api.routes(async (r) => {
          r.post("/on", async () => { api.grantCapability("ext-test-group"); return {}; });
          r.post("/off", async () => { api.revokeCapability("ext-test-group"); return {}; });
        });
      }`,
    });
    expect(allTools().some((t) => t.name === "studio_ext_test")).toBe(true);
    const visible = () => toolsFor(caller).some((t) => t.name === "studio_ext_test");
    expect(visible()).toBe(false);
    await app!.inject({ method: "POST", url: "/api/studio/extensions/grants/on", headers: { cookie }, payload: {} });
    expect(visible()).toBe(true);
    await app!.inject({ method: "POST", url: "/api/studio/extensions/grants/off", headers: { cookie }, payload: {} });
    expect(visible()).toBe(false);
  });
});
