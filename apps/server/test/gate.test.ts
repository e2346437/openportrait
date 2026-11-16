import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "@openportrait/config";
import { dispositionFor, lockCapability, type FeaturePolicy, type RegistryScope } from "../src/ai/registry.js";
import { expireForRemovedTools } from "../src/ai/approvals.js";
import { authorize, bindingFor, GateError, invoke } from "../src/ai/gate.js";
import { buildApp } from "../src/app.js";

// PR 2b: one execution-time gate for live MCP calls and resumed owner approvals, staged and owner-scoped registrations.

const ran: string[] = [];
// Extension modules loaded by a real startup report their calls here too.
(globalThis as { __gateRan?: string[] }).__gateRan = ran;
let app: FastifyInstance;
let cfg: ReturnType<typeof loadConfig>;
let cookie: string;
const scopes: RegistryScope[] = [];
let seq = 0;
const uid = (p: string) => `${p}_${++seq}_${Math.random().toString(36).slice(2, 6)}`;

// Each app has its own registry (`ctx.tools`). These helpers act on the current test app's.
const findTool = (name: string) => app.ctx.tools.find(name);
const allTools = () => app.ctx.tools.all();
const toolsFor = (caller: Parameters<typeof app.ctx.tools.toolsFor>[0]) => app.ctx.tools.toolsFor(caller);
const isCapabilityAvailable = (id: string) => app.ctx.tools.isCapabilityAvailable(id);
const resetRemovalCountersForTests = () => app.ctx.tools.resetRemovalCountersForTests();
const createScope = (owner: string, digest = "", opts: Parameters<typeof app.ctx.tools.createScope>[2] = {}) => app.ctx.tools.createScope(owner, digest, opts);

/** A scope that publishes immediately and is purged after the test. Removal expires approvals in the target app's database, as an extension's scope does. `durable: false` leaves that out, to test the gate's own checks. */
function liveScope(owner: string, digest = "", durable = true, target: () => FastifyInstance = () => app): RegistryScope {
  const s = target().ctx.tools.createScope(owner, digest, { staged: false, onRemove: durable ? (names) => expireForRemovedTools(target().ctx, names) : undefined });
  scopes.push(s);
  return s;
}
const outwardTool = (scope: RegistryScope, name: string, over: Record<string, unknown> = {}) =>
  scope.defineTool({
    name,
    title: name,
    description: name,
    area: "email",
    tier: "outward",
    effect: "outbound",
    input: { to: z.string() },
    summarize: (a: { to: string }) => `Send to ${a.to}`,
    handler: (_c: unknown, a: { to: string }) => {
      ran.push(a.to);
      return { sentTo: a.to };
    },
    ...over,
  } as never);

beforeEach(async () => {
  ran.length = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-"));
  cfg = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  app = await buildApp({ config: cfg, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  await app.inject({ method: "PUT", url: "/api/studio/ai", payload: { enabled: true }, headers: { cookie } });
});
afterEach(async () => {
  for (const s of scopes.splice(0)) s.rollback();
  await app.close();
});

const api = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url: `/api/studio/ai${url}`, payload, headers: { cookie } });
async function connect(level: "read" | "assist" | "full", areas: string[]) {
  const j = (await api("POST", "/connections", { label: "Claude", level, areas })).json();
  return { token: j.token as string, id: j.connection.id as string };
}
const call = async (token: string, name: string, args: object = {}) => {
  const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` } });
  const result = res.json().result;
  if (!result) return { isError: true, data: res.json().error?.message as string };
  return { isError: !!result.isError, data: result.isError ? (result.content[0].text as string) : JSON.parse(result.content[0].text) };
};
const approve = (id: string) => api("POST", `/approvals/${id}/approve`);
const sql = (q: string, ...p: unknown[]) => app.ctx.db.$client.prepare(q).run(...p);
const row = (id: string) => app.ctx.db.$client.prepare("SELECT status, result, binding FROM ai_approval WHERE id = ?").get(id) as { status: string; result: string | null; binding: string | null };

async function queued(name: string, args: object = { to: "a@b.co" }) {
  const c = await connect("full", ["email"]);
  const { data } = await call(c.token, name, args);
  expect(data.status, JSON.stringify(data)).toBe("pending_approval");
  return { ...c, approvalId: data.approvalId as string };
}

describe("one gate for live calls and resumed approvals", () => {
  it("validates arguments on a live call and stores the validated copy", async () => {
    const name = uid("email_gate_args");
    outwardTool(liveScope("ext:gate-args"), name, { input: { to: z.string().max(10) } });
    const { token } = await connect("full", ["email"]);
    expect((await call(token, name, { to: "x".repeat(11) })).isError).toBe(true);
    const ok = await call(token, name, { to: "a@b.co", extra: "dropped" });
    const stored = app.ctx.db.$client.prepare("SELECT args, binding FROM ai_approval WHERE id = ?").get(ok.data.approvalId) as { args: string; binding: string };
    expect(JSON.parse(stored.args)).toEqual({ to: "a@b.co" });
    expect(stored.binding).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses both paths while AI access is paused or turned off", async () => {
    const name = uid("email_gate_switch");
    outwardTool(liveScope("ext:gate-switch"), name);
    const q = await queued(name);
    const live = (ctx = app.ctx) => authorize(ctx, { connectionId: q.id, tool: name, args: { to: "a@b.co" } });
    expect(live().binding).toBe(row(q.approvalId).binding);

    app.ctx.settings.set("ai.paused", true);
    expect(() => live()).toThrow(GateError);
    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "failed" });
    expect(ran).toEqual([]);

    app.ctx.settings.set("ai.paused", false);
    const q2 = await queued(name);
    app.ctx.settings.set("ai.enabled", false);
    expect(() => authorize(app.ctx, { connectionId: q2.id, tool: name, args: { to: "a@b.co" } })).toThrow(/turned off/);
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "failed" });
    expect(ran).toEqual([]);
  });

  it("applies feature policy to both paths and fails closed on throws, promises and odd answers", async () => {
    const owner = "ext:gate-policy";
    const scope = liveScope(owner);
    const name = uid("email_gate_policy");
    outwardTool(scope, name);
    let verdict: unknown = true;
    scope.registerFeaturePolicy((() => {
      if (verdict === "throw") throw new Error("boom");
      return verdict;
    }) as FeaturePolicy);
    const q = await queued(name);

    verdict = { allow: false, message: "Closed for the season." };
    expect((await call(q.token, name, { to: "x@y.co" })).data).toBe("Closed for the season.");
    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "failed", result: { error: "Closed for the season." } });

    for (const v of ["throw", Promise.resolve(true), undefined, "yes", 1, null]) {
      verdict = v;
      expect((await call(q.token, name, { to: "x@y.co" })).isError, String(v)).toBe(true);
    }
    expect(ran).toEqual([]);

    verdict = true;
    const q2 = await queued(name);
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "approved" });
    expect(ran).toEqual(["a@b.co"]);
  });

  it("re-resolves the registration at execution: a removed or re-capabilitied tool no longer runs", async () => {
    const owner = "ext:gate-gone";
    const scope = liveScope(owner, "", false); // removal normally expires the pending request on the spot (covered below); without that, the gate's own check is what's tested
    const name = uid("email_gate_gone");
    outwardTool(scope, name);
    const q = await queued(name);
    scope.rollback();
    expect(findTool(name)).toBeUndefined();
    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "failed", result: { error: expect.stringMatching(/isn't available/) } });
    expect(ran).toEqual([]);

    // With the durable step in place, removal expires the request before anyone can approve it.
    const gone2 = liveScope("ext:gate-gone2");
    const n3 = uid("email_gate_gone2");
    outwardTool(gone2, n3);
    const q3 = await queued(n3);
    gone2.rollback();
    expect(row(q3.approvalId).status).toBe("expired");
    expect((await approve(q3.approvalId)).statusCode).toBe(409);
    expect(ran).toEqual([]);

    const cap = uid("cap");
    const s2 = liveScope("ext:gate-cap");
    s2.lockCapability(cap);
    const n2 = uid("email_gate_cap");
    outwardTool(s2, n2, { capability: cap });
    s2.grantCapability(cap);
    const q2 = await queued(n2);
    s2.revokeCapability(cap);
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "failed" });
    expect(ran).toEqual([]);
  });

  it("rejects a stale approval when the registration changed under it", async () => {
    const name = uid("email_gate_stale");
    const v1 = liveScope("ext:gate-stale", "digest-1", false); // no durable expiry, so the fingerprint check is what's tested
    outwardTool(v1, name);
    const q = await queued(name);
    v1.rollback();
    // Same name and shape, but a different module build: not the thing the owner was asked about.
    outwardTool(liveScope("ext:gate-stale", "digest-2"), name);
    const res = (await approve(q.approvalId)).json();
    expect(res).toMatchObject({ status: "expired", result: { error: expect.stringMatching(/out of date/) } });
    expect(ran).toEqual([]);

    // A changed input shape is stale too.
    const n2 = uid("email_gate_stale2");
    const a = liveScope("ext:gate-stale2", "", false);
    outwardTool(a, n2);
    const q2 = await queued(n2);
    a.rollback();
    outwardTool(liveScope("ext:gate-stale2"), n2, { input: { to: z.string(), cc: z.string().optional() } });
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "expired" });
    expect(ran).toEqual([]);
  });

  it("expires a pending approval when the tool is removed and registered again with identical metadata", async () => {
    const name = uid("email_gate_replaced");
    const v1 = liveScope("ext:gate-replaced", "same-digest", false); // the in-process counter is a second line of defence next to the durable expiry; test it alone
    const first = outwardTool(v1, name);
    const q = await queued(name);
    const before = findTool(name)!.fingerprint;
    v1.rollback();
    expect(findTool(name)).toBeUndefined();
    // Same owner, build digest, tier, effect, area and input shape: only the removal in between differs.
    outwardTool(liveScope("ext:gate-replaced", "same-digest"), name);
    expect(first.name).toBe(name);
    expect(findTool(name)!.fingerprint).not.toBe(before);

    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "expired", result: { error: expect.stringMatching(/out of date/) } });
    expect(row(q.approvalId).status).toBe("expired");
    expect(ran).toEqual([]);

    // A request queued against the replacement is bound to it and runs once.
    const q2 = await queued(name);
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "approved" });
    expect(ran).toEqual(["a@b.co"]);
  });

  it("keeps a removed tool's old approval expired when an identical registration returns after a restart", async () => {
    const name = uid("email_gate_restart_removed");
    const v1 = liveScope("ext:gate-restart-removed", "same-digest");
    outwardTool(v1, name);
    const other = uid("email_gate_restart_kept");
    outwardTool(liveScope("ext:gate-restart-kept", "kept-digest"), other);
    const q = await queued(name);
    const qOther = await queued(other);
    const before = findTool(name)!.fingerprint;

    v1.rollback();
    // Removal is durable straight away, not just in this process's memory, and only touches the removed tool's approvals.
    expect(row(q.approvalId).status).toBe("expired");
    expect(row(qOther.approvalId).status).toBe("pending");

    // A restart forgets the in-process removal counters, so the identical registration gets the original fingerprint back.
    resetRemovalCountersForTests();
    outwardTool(liveScope("ext:gate-restart-removed", "same-digest"), name);
    expect(findTool(name)!.fingerprint).toBe(before);

    // The old approval is still dead: it can't be listed as pending or approved.
    expect((await api("GET", "/approvals/summary")).json().pending).toBe(1); // only the unrelated tool's request
    expect((await approve(q.approvalId)).statusCode).toBe(409);
    expect(row(qOther.approvalId).status).toBe("pending");
    expect(ran).toEqual([]);

    // A request queued against the returned registration works normally.
    const q2 = await queued(name);
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "approved" });
    expect(ran).toEqual(["a@b.co"]);
  });

  it("keeps pending approvals valid across an ordinary restart with an unchanged registration", async () => {
    const name = uid("email_gate_restart_same");
    const v1 = liveScope("ext:gate-restart-same", "same-digest", false);
    outwardTool(v1, name);
    const q = await queued(name);
    const before = findTool(name)!.fingerprint;

    // A restart ends the process without removing anything through the registry: no removal reaches the database.
    v1.rollback();
    resetRemovalCountersForTests();
    outwardTool(liveScope("ext:gate-restart-same", "same-digest"), name);

    expect(findTool(name)!.fingerprint).toBe(before);
    expect(row(q.approvalId).status).toBe("pending");
    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "approved", result: { sentTo: "a@b.co" } });
    expect(ran).toEqual(["a@b.co"]);
  });

  it("rejects an approval whose stored arguments or connection were altered", async () => {
    const name = uid("email_gate_tamper");
    outwardTool(liveScope("ext:gate-tamper"), name);

    const q = await queued(name);
    sql("UPDATE ai_approval SET args = ? WHERE id = ?", JSON.stringify({ to: "evil@x.co" }), q.approvalId);
    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "expired" });

    const q2 = await queued(name);
    const other = await connect("full", ["email"]);
    sql("UPDATE ai_approval SET connection_id = ? WHERE id = ?", other.id, q2.approvalId);
    expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "expired" });

    const q3 = await queued(name);
    sql("UPDATE ai_approval SET args = ? WHERE id = ?", JSON.stringify({ to: 5 }), q3.approvalId);
    expect((await approve(q3.approvalId)).json()).toMatchObject({ status: "failed" }); // no longer valid arguments
    expect(ran).toEqual([]);
  });

  it("expires legacy pending approvals that have no binding", async () => {
    const name = uid("email_gate_legacy");
    outwardTool(liveScope("ext:gate-legacy"), name);
    const q = await queued(name);
    sql("UPDATE ai_approval SET binding = NULL WHERE id = ?", q.approvalId);
    expect((await api("GET", "/approvals/summary")).json().pending).toBe(0);
    expect(row(q.approvalId).status).toBe("expired");
    expect((await approve(q.approvalId)).statusCode).toBe(409);
    expect(ran).toEqual([]);
  });

  it("runs an untouched approval exactly once, even with many simultaneous approvals", async () => {
    const name = uid("email_gate_race");
    outwardTool(liveScope("ext:gate-race"), name);
    const q = await queued(name);
    const results = await Promise.all(Array.from({ length: 8 }, () => approve(q.approvalId)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(7);
    expect(ran).toEqual(["a@b.co"]);
  });

  it("never runs when a revoke races an approval; the outcome is consistent either way", async () => {
    const name = uid("email_gate_revoke");
    outwardTool(liveScope("ext:gate-revoke"), name);
    const q = await queued(name);
    const [a] = await Promise.all([approve(q.approvalId), api("DELETE", `/connections/${q.id}`)]);
    const status = row(q.approvalId).status;
    if (ran.length === 1) expect(status).toBe("approved");
    else expect(["declined", "failed"]).toContain(status);
    expect(ran.length).toBeLessThanOrEqual(1);
    expect([200, 409]).toContain(a.statusCode);
  });

  it("keeps sensitive tools behind the authorization code through the same gate", async () => {
    const { token } = await connect("full", ["studio"]);
    const r = await call(token, "studio_set_automation_mode", { mode: "built-in" });
    expect(r.isError).toBe(true);
    expect(r.data).toMatch(/authorization|code/i);
  });
});

describe("tool effect classification", () => {
  it("classifies every core tool and keeps effect consistent with tier", () => {
    const core = allTools().filter((t) => t.owner === "core");
    expect(core.length).toBeGreaterThan(30);
    for (const t of core) {
      if (t.tier === "read") expect(["read", "read-existing"], t.name).toContain(t.effect);
      if (t.tier === "draft") expect(t.effect, t.name).toBe("write");
      if (t.tier === "outward") expect(t.effect, t.name).toBe("outbound");
    }
    expect(findTool("contacts_get")?.effect).toBe("read-existing");
    expect(findTool("contacts_search")?.effect).toBe("read");
    expect(findTool("contacts_add_note")?.effect).toBe("write");
    expect(findTool("quotes_send")?.effect).toBe("outbound");
  });

  it("refuses inconsistent or unknown registrations and defaults the rest to the stricter effect", () => {
    const s = liveScope("ext:gate-effects");
    const base = { title: "t", description: "t", area: "email" as const, input: {}, handler: () => 1 };
    expect(() => s.defineTool({ ...base, name: uid("x_draft"), tier: "draft", effect: "outbound" })).toThrow(/effect/);
    expect(() => s.defineTool({ ...base, name: uid("x_read"), tier: "read", effect: "write" })).toThrow(/effect/);
    expect(() => s.defineTool({ ...base, name: uid("x_area"), tier: "read", area: "nope" as never })).toThrow(/area/);
    expect(() => s.defineTool({ ...base, name: uid("x_tier"), tier: "nope" as never })).toThrow(/tier/);
    const a = uid("x_d1");
    const b = uid("x_d2");
    const c = uid("x_d3");
    s.defineTool({ ...base, name: a, tier: "read" });
    s.defineTool({ ...base, name: b, tier: "outward" });
    s.defineTool({ ...base, name: c, tier: "money" });
    expect([findTool(a)?.effect, findTool(b)?.effect, findTool(c)?.effect]).toEqual(["read", "outbound", "write"]);
  });

  it("freezes a registration so its owner can't loosen it afterwards", () => {
    const s = liveScope("ext:gate-frozen");
    const def = { title: "t", description: "t", area: "email" as const, tier: "outward" as const, input: {}, handler: () => 1, name: uid("x_frozen") };
    s.defineTool(def);
    def.tier = "read" as never;
    expect(findTool(def.name)?.tier).toBe("outward");
    expect(() => {
      (findTool(def.name) as { tier: string }).tier = "read";
    }).toThrow(TypeError);
  });
});

describe("staged registrations and rollback", () => {
  it("shows nothing until commit and removes everything on rollback", () => {
    const cap = uid("cap");
    const s = createScope("ext:stage-1");
    const name = uid("studio_stage");
    s.lockCapability(cap);
    s.defineTool({ name, title: "t", description: "t", area: "studio", tier: "read", capability: cap, input: {}, handler: () => 1 });
    s.grantCapability(cap);
    expect(findTool(name)).toBeUndefined();
    s.commit();
    expect(findTool(name)?.owner).toBe("ext:stage-1");
    expect(isCapabilityAvailable(cap)).toBe(true);
    s.rollback();
    expect(findTool(name)).toBeUndefined();
    expect(() => s.lockCapability("late")).toThrow(/no longer registered/);
  });

  it("drops staged work on rollback before commit, leaving locks and grants untouched", () => {
    const cap = uid("cap");
    const s = createScope("ext:stage-2");
    s.lockCapability(cap);
    s.grantCapability(cap);
    s.rollback();
    // The lock never existed, so the (now unowned) capability is just available and another owner can claim it.
    expect(isCapabilityAvailable(cap)).toBe(true);
    const other = liveScope("ext:stage-2b");
    other.lockCapability(cap);
    expect(isCapabilityAvailable(cap)).toBe(false);
  });

  it("publishes all or nothing when commit hits a conflict", () => {
    const s = createScope("ext:stage-3");
    const a = uid("studio_atomic_a");
    const b = uid("studio_atomic_b");
    const mk = (name: string) => ({ name, title: "t", description: "t", area: "studio" as const, tier: "read" as const, input: {}, handler: () => 1 });
    s.defineTool(mk(a));
    s.defineTool(mk(b));
    liveScope("ext:stage-3-rival").defineTool(mk(b)); // lands while s is still staging
    expect(() => s.commit()).toThrow(/Duplicate/);
    expect(findTool(a)).toBeUndefined();
    expect(findTool(b)?.owner).toBe("ext:stage-3-rival");
  });

  it("leaves no tools, locks, grants or policies behind when an extension's register() fails", async () => {
    const cap = uid("ext-cap");
    const name = uid("studio_ext_fail");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-ext-"));
    const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
    fs.mkdirSync(path.join(config.configDir, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(config.configDir, "extensions", "failing.mjs"),
      `export function register(api) {
        api.lockCapability(${JSON.stringify(cap)});
        api.defineTool({ name: ${JSON.stringify(name)}, title: "t", description: "t", area: "studio", tier: "read", capability: ${JSON.stringify(cap)}, input: {}, handler: () => "ok" });
        api.grantCapability(${JSON.stringify(cap)});
        api.featurePolicy(() => false);
        throw new Error("licence check failed");
      }`,
    );
    const failing = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
    try {
      const info = (await failing.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "L", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } })).cookies.find((c) => c.name === "op_session")!;
      const list = (await failing.inject({ method: "GET", url: "/api/studio/extensions", headers: { cookie: `op_session=${info.value}` } })).json().extensions;
      expect(list[0]).toMatchObject({ id: "failing", status: "failed", error: "licence check failed" });
      expect(findTool(name)).toBeUndefined();
      // The lock is gone too, so another owner can use the name of that group.
      const other = liveScope("ext:after-failure");
      other.lockCapability(cap);
      expect(isCapabilityAvailable(cap)).toBe(false);
      // The policy is gone: a tool from a healthy owner is not blocked by the failed module's `() => false`.
      const ok = uid("studio_ext_ok");
      other.defineTool({ name: ok, title: "t", description: "t", area: "studio", tier: "read", input: {}, handler: () => 1 });
      other.grantCapability(cap);
      expect(toolsFor({ level: "read", areas: ["studio"] }).some((t) => t.name === ok)).toBe(true);
    } finally {
      await failing.close();
    }
  });
});

describe("ownership and isolation", () => {
  it("keeps one extension from locking, granting or joining another's capability", () => {
    const cap = uid("cap-owned");
    const a = liveScope("ext:own-a");
    const b = liveScope("ext:own-b");
    a.lockCapability(cap);
    a.defineTool({ name: uid("studio_own_a"), title: "t", description: "t", area: "studio", tier: "read", capability: cap, input: {}, handler: () => 1 });
    expect(() => b.lockCapability(cap)).toThrow(/already locked/);
    expect(() => b.grantCapability(cap)).toThrow(/another extension/);
    expect(() => b.revokeCapability(cap)).toThrow(/another extension/);
    expect(() => b.defineTool({ name: uid("studio_own_b"), title: "t", description: "t", area: "studio", tier: "read", capability: cap, input: {}, handler: () => 1 })).toThrow(/another extension/);
    expect(isCapabilityAvailable(cap)).toBe(false);
    a.grantCapability(cap);
    expect(isCapabilityAvailable(cap)).toBe(true);
  });

  it("can't lock a group that already has another owner's tools, such as a core group", () => {
    const s = liveScope("ext:own-c");
    expect(() => s.lockCapability("invoicing")).toThrow(/another owner/);
    expect(toolsFor({ level: "full", areas: ["orders"] }).some((t) => t.name === "orders_list")).toBe(true);
  });

  it("lets only the module that granted a core-locked group revoke it", async () => {
    const cap = uid("cap-core");
    expect(() => createScope("core")).toThrow(/reserved/);
    lockCapability(cap); // core locks it (a built-in definition, made before an app starts); extensions may grant it
    await app.close();
    app = await buildApp({ config: cfg, startBackground: false, setupCode: null, logger: false }); // an app started now has the lock
    const a = liveScope("ext:own-d");
    const b = liveScope("ext:own-e");
    a.grantCapability(cap);
    expect(() => b.grantCapability(cap)).toThrow(/another owner/);
    expect(() => b.revokeCapability(cap)).toThrow(/another owner/);
    expect(isCapabilityAvailable(cap)).toBe(true);
    a.revokeCapability(cap);
    expect(isCapabilityAvailable(cap)).toBe(false);
  });

  it("scopes an extension's feature policy to its own tools and groups", async () => {
    const a = liveScope("ext:own-f");
    const b = liveScope("ext:own-g");
    const mine = uid("email_own_f");
    const theirs = uid("email_own_g");
    outwardTool(a, mine);
    outwardTool(b, theirs);
    a.registerFeaturePolicy(() => false);
    const { id } = await connect("full", ["email", "studio"]);
    expect(() => authorize(app.ctx, { connectionId: id, tool: mine, args: { to: "a@b.co" } })).toThrow(GateError);
    expect(authorize(app.ctx, { connectionId: id, tool: theirs, args: { to: "a@b.co" } }).tool.name).toBe(theirs);
    expect(authorize(app.ctx, { connectionId: id, tool: "studio_get_summary", args: {} }).tool.owner).toBe("core");
  });

  it("removes only the failing owner's registrations", () => {
    const a = liveScope("ext:own-h");
    const b = liveScope("ext:own-i");
    const na = uid("studio_own_h");
    const nb = uid("studio_own_i");
    const mk = (name: string) => ({ name, title: "t", description: "t", area: "studio" as const, tier: "read" as const, input: {}, handler: () => 1 });
    a.defineTool(mk(na));
    b.defineTool(mk(nb));
    a.rollback();
    expect(findTool(na)).toBeUndefined();
    expect(findTool(nb)).toBeDefined();
    expect(findTool("studio_get_summary")?.owner).toBe("core");
  });
});

describe("unlicensed core behaviour", () => {
  it("runs core read and draft tools exactly as before when no extension is present", async () => {
    const { token } = await connect("assist", ["studio", "contacts"]);
    expect((await call(token, "studio_whoami")).isError).toBe(false);
    const made = await call(token, "contacts_search", { q: "nobody" });
    expect(made.isError).toBe(false);
    expect(allTools().every((t) => !!t.fingerprint && !!t.owner)).toBe(true);
  });
});

describe("effect enforcement at execution", () => {
  const tiers = ["read", "draft", "outward", "money", "sensitive"] as const;
  const effects = ["read-existing", "read", "write", "outbound"] as const;

  it("decides every effect and tier combination explicitly, and refuses the rest", () => {
    const table: Record<string, string | null> = {
      "read-existing/read": "run",
      "read/read": "run",
      "write/draft": "run",
      "write/sensitive": "code",
      "write/money": "approve",
      "outbound/outward": "approve",
      "outbound/money": "approve",
    };
    for (const effect of effects) for (const tier of tiers) expect(dispositionFor({ effect, tier }), `${effect}/${tier}`).toBe(table[`${effect}/${tier}`] ?? null);
    expect(dispositionFor({ effect: "teleport" as never, tier: "read" })).toBeNull();
  });

  it("won't register a sensitive tool as outbound, so nothing that reaches a client can skip approval", () => {
    const s = liveScope("ext:eff-sens");
    expect(() => s.defineTool({ name: uid("x_sens"), title: "t", description: "t", area: "studio", tier: "sensitive", effect: "outbound", input: {}, handler: () => 1 })).toThrow(/effect/);
  });

  describe("direct MCP execution", () => {
    const mk = (scope: RegistryScope, name: string, tier: "read" | "draft" | "outward" | "money", effect: "read-existing" | "read" | "write" | "outbound") =>
      scope.defineTool({ name, title: name, description: name, area: "email", tier, effect, input: {}, handler: () => (ran.push(name), { ran: name }) });

    it("runs read, read-existing and draft write straight away, and queues outbound and money", async () => {
      const s = liveScope("ext:eff-direct");
      const n = { read: uid("e_read"), existing: uid("e_existing"), write: uid("e_write"), out: uid("e_out"), money: uid("e_money"), moneyOut: uid("e_moneyout") };
      mk(s, n.read, "read", "read");
      mk(s, n.existing, "read", "read-existing");
      mk(s, n.write, "draft", "write");
      mk(s, n.out, "outward", "outbound");
      mk(s, n.money, "money", "write");
      mk(s, n.moneyOut, "money", "outbound");
      const { token } = await connect("full", ["email"]);
      for (const name of [n.read, n.existing, n.write]) expect((await call(token, name)).data, name).toEqual({ ran: name });
      expect(ran).toEqual([n.read, n.existing, n.write]);
      for (const name of [n.out, n.money, n.moneyOut]) expect((await call(token, name)).data, name).toMatchObject({ status: "pending_approval" });
      expect(ran).toEqual([n.read, n.existing, n.write]); // none of the queued ones ran
    });

    it("refuses to run an approval-only tool directly, and a code tool without a verified code", async () => {
      const s = liveScope("ext:eff-invoke");
      const out = uid("e_inv_out");
      mk(s, out, "outward", "outbound");
      const { id } = await connect("full", ["email", "studio"]);
      const outGrant = authorize(app.ctx, { connectionId: id, tool: out, args: {} });
      expect(outGrant.disposition).toBe("approve");
      await expect(invoke(app.ctx, outGrant, "direct")).rejects.toThrow(/approved by the studio owner/);
      await expect(invoke(app.ctx, outGrant, "direct", { codeVerified: true })).rejects.toThrow(GateError);
      expect(ran).toEqual([]);

      const sens = authorize(app.ctx, { connectionId: id, tool: "studio_set_automation_mode", args: { mode: "built-in" } });
      expect(sens.disposition).toBe("code");
      await expect(invoke(app.ctx, sens, "direct")).rejects.toThrow(GateError);
      await expect(invoke(app.ctx, sens, "direct", { codeVerified: false })).rejects.toThrow(GateError);
      await expect(invoke(app.ctx, sens, "approved")).rejects.toThrow(GateError);
    });

    it("refuses a grant whose effect no longer matches its tier or its decided disposition", async () => {
      const s = liveScope("ext:eff-forged");
      const draft = uid("e_forge");
      mk(s, draft, "draft", "write");
      const { id } = await connect("full", ["email"]);
      const grant = authorize(app.ctx, { connectionId: id, tool: draft, args: {} });
      expect(grant.disposition).toBe("run");
      const outboundDraft = { ...grant, tool: { ...grant.tool, effect: "outbound" as const } };
      await expect(invoke(app.ctx, outboundDraft, "direct")).rejects.toThrow(GateError);
      const relabelled = { ...grant, disposition: "approve" as const };
      await expect(invoke(app.ctx, relabelled, "direct")).rejects.toThrow(GateError);
      await expect(invoke(app.ctx, grant, "approved")).rejects.toThrow(GateError); // a run tool can't be resumed as approved
      expect(ran).toEqual([]);
      expect(await invoke(app.ctx, grant, "direct")).toEqual({ ran: draft });
    });
  });

  describe("resumed owner approvals", () => {
    /** Inserts a pending approval for any tool with a correct binding, as if it had been queued. */
    function forge(connectionId: string, tool: string, args: object) {
      const reg = findTool(tool)!;
      const id = `forged-${uid("a")}`;
      sql("INSERT INTO ai_approval (id, connection_id, tool, tier, summary, args, binding, expires_at) VALUES (?, ?, ?, 'money', 's', ?, ?, ?)", id, connectionId, tool, JSON.stringify(args), bindingFor(reg, connectionId, args), Date.now() + 86_400_000);
      return id;
    }

    it("won't run a read, draft or sensitive tool from an approval row, even with a valid binding", async () => {
      const s = liveScope("ext:eff-resume");
      const mk = (name: string, tier: "read" | "draft", effect: "read" | "write") => s.defineTool({ name, title: name, description: name, area: "email", tier, effect, input: {}, handler: () => (ran.push(name), 1) });
      const [r, d] = [uid("e_res_read"), uid("e_res_draft")];
      mk(r, "read", "read");
      mk(d, "draft", "write");
      const { id } = await connect("full", ["email", "studio"]);
      for (const [tool, args] of [[r, {}], [d, {}], ["studio_set_automation_mode", { mode: "ai" }]] as const) {
        const approvalId = forge(id, tool, args);
        const res = (await approve(approvalId)).json();
        expect(res, tool).toMatchObject({ status: "failed", result: { error: expect.stringMatching(/doesn't need approval/) } });
      }
      expect(ran).toEqual([]);
      expect(app.ctx.settings.get("automation.mode")).not.toBe("ai");
    });

    it("still runs outbound and money-tier approvals once the owner approves", async () => {
      const s = liveScope("ext:eff-resume-ok");
      const out = uid("e_res_out");
      const money = uid("e_res_money");
      outwardTool(s, out);
      s.defineTool({ name: money, title: money, description: money, area: "email", tier: "money", effect: "write", input: { to: z.string() }, handler: (_c: unknown, a: { to: string }) => (ran.push(`${money}:${a.to}`), { ok: true }) } as never);
      const q1 = await queued(out);
      const q2 = await queued(money, { to: "m@b.co" });
      expect((await approve(q1.approvalId)).json()).toMatchObject({ status: "approved", result: { sentTo: "a@b.co" } });
      expect((await approve(q2.approvalId)).json()).toMatchObject({ status: "approved" });
      expect(ran).toEqual(["a@b.co", `${money}:m@b.co`]);
    });
  });
});

describe("durable removal and startup expiry", () => {
  it("expires approvals in the scope's own database however other apps open and close", async () => {
    const name = uid("email_gate_overlap");
    const first = app;
    const scope = liveScope("ext:gate-overlap", "same-digest", true, () => first);
    outwardTool(scope, name);
    const q = await queued(name);

    // Other apps open and close while this one is running, in every order.
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-b-"));
    const other = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: rootB, WEB_DIR: path.join(rootB, "web") }), startBackground: false, setupCode: null, logger: false });
    await other.close();
    const rootC = fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-c-"));
    const later = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: rootC, WEB_DIR: path.join(rootC, "web") }), startBackground: false, setupCode: null, logger: false });
    try {
      scope.rollback(); // while a newer app is open
      expect(row(q.approvalId).status).toBe("expired"); // the removal reached the database it was made for
      expect(later.ctx.db.$client.prepare("SELECT count(*) AS n FROM ai_approval").get()).toEqual({ n: 0 }); // and nobody else's
    } finally {
      await later.close();
    }
    expect((await approve(q.approvalId)).statusCode).toBe(409);
    expect(ran).toEqual([]);
  });

  // Real restarts: the module sits in the extensions folder, and every start of the app loads it into that app's own registry.
  const extPath = (config: ReturnType<typeof loadConfig>, id: string) => path.join(config.configDir, "extensions", `${id}.mjs`);
  const writeExt = (config: ReturnType<typeof loadConfig>, id: string, name: string) => {
    fs.mkdirSync(path.join(config.configDir, "extensions"), { recursive: true });
    fs.writeFileSync(
      extPath(config, id),
      `export function register(api) {
        api.defineTool({ name: ${JSON.stringify(name)}, title: "t", description: "t", area: "email", tier: "outward", effect: "outbound", input: { to: api.z.string() }, summarize: (a) => "Send to " + a.to, handler: (_c, a) => { globalThis.__gateRan?.push(a.to); return { sentTo: a.to }; } });
      }`,
    );
  };
  const restart = async (config: ReturnType<typeof loadConfig>) => {
    await app.close();
    app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  };

  it("expires pending approvals for a tool missing at startup, even when an identical tool returns later", async () => {
    const name = uid("email_gate_absent");
    const keep = uid("email_gate_absent_kept");
    writeExt(cfg, "absent", name);
    writeExt(cfg, "absent-kept", keep);
    await restart(cfg); // startup: both modules load
    const q = await queued(name);
    const qKept = await queued(keep);

    // The server stops, and the module is deleted while it is down: no removal event reaches the database.
    await app.close();
    fs.rmSync(extPath(cfg, "absent"));

    // Startup one: the tool is missing. Its pending approval expires before a request is accepted; an unrelated tool's stays.
    app = await buildApp({ config: cfg, startBackground: false, setupCode: null, logger: false });
    expect(findTool(name)).toBeUndefined();
    expect(row(q.approvalId).status).toBe("expired");
    expect(row(qKept.approvalId).status).toBe("pending");

    // Startup two: the identical tool is back. The old approval does not come back with it.
    writeExt(cfg, "absent", name);
    await restart(cfg);
    expect(findTool(name)).toBeDefined();
    expect(row(q.approvalId).status).toBe("expired");
    expect((await approve(q.approvalId)).statusCode).toBe(409);
    expect((await approve(qKept.approvalId)).json()).toMatchObject({ status: "approved" });
    expect(ran).toEqual(["a@b.co"]);
  });

  it("keeps pending approvals across an ordinary restart when every tool loads again unchanged", async () => {
    const name = uid("email_gate_ordinary");
    writeExt(cfg, "ordinary", name);
    await restart(cfg);
    const q = await queued(name);

    await restart(cfg); // the module loads again, unchanged, before the new server accepts requests

    expect(row(q.approvalId).status).toBe("pending");
    expect((await approve(q.approvalId)).json()).toMatchObject({ status: "approved", result: { sentTo: "a@b.co" } });
    expect(ran).toEqual(["a@b.co"]);
  });

  it("stops startup, loudly, when a half-loaded extension can't be removed because the database write fails", async () => {
    const name = uid("studio_ext_stuck");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-stuck-"));
    const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
    fs.mkdirSync(path.join(config.configDir, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(config.configDir, "extensions", "stuck.mjs"),
      // Publishes a tool, breaks the table that removal writes to, then fails while mounting routes (after the tools are live).
      `export function register(api) {
        api.defineTool({ name: ${JSON.stringify(name)}, title: "t", description: "t", area: "studio", tier: "read", input: {}, handler: () => "ok" });
        api.ctx.db.$client.exec("ALTER TABLE ai_approval RENAME TO ai_approval_gone");
        api.routes(async () => { throw new Error("route mount failed"); });
      }`,
    );
    const err = await buildApp({ config, startBackground: false, setupCode: null, logger: false }).then(
      () => null,
      (e: Error) => e,
    );
    // The server does not come up, and the error says which extension and why.
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/stuck/);
    expect(err!.message).toMatch(/route mount failed/);
    expect(err!.message).toMatch(/rollback failed/);
    expect(err!.message).toMatch(/half loaded/);
    expect(err!.cause).toBeInstanceOf(Error);
    // The registry was left as it was (removal never half-happens), which is why startup stopped rather than carrying on.
    // That app never finished building, so the app the test started with is untouched: it has no such tool.
    expect(findTool(name)).toBeUndefined();
  });
});

// Two apps in one process, each with its own data root. Nothing mutable is shared: the registry, the removal counters,
// the capability switches and the approvals all belong to the app that made them.
describe("overlapping apps keep their own registries and approvals", () => {
  interface Handle {
    app: FastifyInstance;
    cookie: string;
  }
  const extra: FastifyInstance[] = [];
  afterEach(async () => {
    for (const a of extra.splice(0)) await a.close().catch(() => undefined);
  });

  const configAt = (root: string) => loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  const freshRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-two-"));
  async function startSecond(config: ReturnType<typeof loadConfig>): Promise<Handle> {
    const second = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
    extra.push(second);
    const res = await second.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Second", ownerName: "Sam", email: "sam@example.com", password: "correct horse battery", timezone: "UTC" } });
    const c = `op_session=${res.cookies.find((x) => x.name === "op_session")!.value}`;
    await second.inject({ method: "PUT", url: "/api/studio/ai", payload: { enabled: true }, headers: { cookie: c } });
    return { app: second, cookie: c };
  }
  /** Runs the shared helpers (connect, call, queued, approve, row) against another app. */
  async function using<T>(h: Handle, fn: () => Promise<T> | T): Promise<T> {
    const prev = { app, cookie };
    app = h.app;
    cookie = h.cookie;
    try {
      return await fn();
    } finally {
      app = prev.app;
      cookie = prev.cookie;
    }
  }
  const authorizeIn = (a: FastifyInstance, connectionId: string, tool: string) => () => authorize(a.ctx, { connectionId, tool, args: { to: "x@y.co" } });
  const extFile = (config: ReturnType<typeof loadConfig>, name: string) => {
    fs.mkdirSync(path.join(config.configDir, "extensions"), { recursive: true });
    const file = path.join(config.configDir, "extensions", "shared.mjs");
    fs.writeFileSync(
      file,
      `export function register(api) {
        api.defineTool({ name: ${JSON.stringify(name)}, title: "t", description: "t", area: "email", tier: "outward", effect: "outbound", input: { to: api.z.string() }, summarize: (a) => "Send to " + a.to, handler: (_c, a) => { globalThis.__gateRan?.push(a.to); return { sentTo: a.to }; } });
      }`,
    );
    return file;
  };

  it("loads a tool in app A only, and B's startup expires B's pending approval while A's stays valid", async () => {
    const name = uid("email_two_apps");
    const cfgB = configAt(freshRoot());

    // B has the tool loaded once and queues an approval for it, then stops. A (still running) loads the same tool and queues its own.
    const fileB = extFile(cfgB, name);
    const b1 = await startSecond(cfgB);
    const qB = await using(b1, () => queued(name));
    await b1.app.close();
    extFile(cfg, name);
    await app.close();
    app = await buildApp({ config: cfg, startBackground: false, setupCode: null, logger: false });
    const qA = await queued(name);
    expect(app.ctx.tools.find(name)).toBeDefined();

    // B starts again while A is open, and this time the module is gone: the tool is absent from B's registry and nowhere else's.
    fs.rmSync(fileB);
    const b2 = await buildApp({ config: cfgB, startBackground: false, setupCode: null, logger: false });
    extra.push(b2);
    expect(b2.ctx.tools.find(name)).toBeUndefined();
    expect(app.ctx.tools.find(name)).toBeDefined();
    expect(b2.ctx.db.$client.prepare("SELECT status FROM ai_approval WHERE id = ?").get(qB.approvalId)).toEqual({ status: "expired" });

    // A is untouched: its approval is still pending, and its tool still runs it once.
    expect(row(qA.approvalId).status).toBe("pending");
    expect((await approve(qA.approvalId)).json()).toMatchObject({ status: "approved", result: { sentTo: "a@b.co" } });
    expect(ran).toEqual(["a@b.co"]);
    // B's stays expired, and B never runs it.
    const second = await b2.inject({ method: "POST", url: `/api/studio/ai/approvals/${qB.approvalId}/approve`, headers: { cookie: b1.cookie } });
    expect(second.statusCode).toBe(409);
    expect(ran).toEqual(["a@b.co"]);
  });

  it("lists, runs and resumes a tool through the registry of the app that owns it", async () => {
    const name = uid("email_two_apps_view");
    const B = await startSecond(configAt(freshRoot()));
    outwardTool(liveScope("ext:two-view", "d"), name); // registered on app A only
    expect(app.ctx.tools.find(name)).toBeDefined();
    expect(B.app.ctx.tools.find(name)).toBeUndefined();

    const cA = await connect("full", ["email"]);
    const cB = await using(B, () => connect("full", ["email"]));
    // Discovery: A's connection can call it; B's connection cannot see it, and a direct call is refused as unavailable.
    expect((await call(cA.token, name, { to: "a@b.co" })).data).toMatchObject({ status: "pending_approval" });
    const viaB = await B.app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { to: "x@y.co" } } }, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${cB.token}` } });
    expect(JSON.stringify(viaB.json())).not.toMatch(/pending_approval/);
    expect(authorizeIn(B.app, cB.id, name)).toThrow(/isn't available/);
    expect(authorizeIn(app, cA.id, name)).not.toThrow();
  });

  it("closing or rolling back an extension in one app leaves the other app's registry and approvals intact", async () => {
    const name = uid("email_two_apps_rb");
    const B = await startSecond(configAt(freshRoot()));
    const A: Handle = { app, cookie };
    // The same extension (same name and digest) is loaded in both apps, and each queues an approval.
    const scopeA = liveScope("ext:two-rb", "same", true, () => A.app);
    const scopeB = B.app.ctx.tools.createScope("ext:two-rb", "same", { staged: false, onRemove: (names) => expireForRemovedTools(B.app.ctx, names) });
    outwardTool(scopeA, name);
    outwardTool(scopeB, name);
    const qA = await queued(name);
    const qB = await using(B, () => queued(name));
    const fpB = B.app.ctx.tools.find(name)!.fingerprint;

    // Rolling A's extension back removes A's tool and expires A's approval, and nothing of B's.
    scopeA.rollback();
    expect(app.ctx.tools.find(name)).toBeUndefined();
    expect(row(qA.approvalId).status).toBe("expired");
    expect(B.app.ctx.tools.find(name)).toBeDefined();
    expect(B.app.ctx.tools.find(name)!.fingerprint).toBe(fpB); // A's removal counter didn't touch B's registration identity
    expect(B.app.ctx.db.$client.prepare("SELECT status FROM ai_approval WHERE id = ?").get(qB.approvalId)).toEqual({ status: "pending" });

    // Closing A leaves B just as it was, and B's approval still runs once.
    await app.close();
    expect(B.app.ctx.tools.find(name)).toBeDefined();
    const ok = await B.app.inject({ method: "POST", url: `/api/studio/ai/approvals/${qB.approvalId}/approve`, headers: { cookie: B.cookie } });
    expect(ok.json()).toMatchObject({ status: "approved", result: { sentTo: "a@b.co" } });
    expect(ran).toEqual(["a@b.co"]);

    // Rolling back B's extension is B's business alone; closing B afterwards is fine too.
    scopeB.rollback();
    expect(B.app.ctx.tools.find(name)).toBeUndefined();
    app = await buildApp({ config: cfg, startBackground: false, setupCode: null, logger: false }); // so the shared afterEach has an app to close
  });

  it("keeps capability switches per app", async () => {
    const B = await startSecond(configAt(freshRoot()));
    app.ctx.tools.setCapabilityEnabled("invoicing", false);
    expect(app.ctx.tools.isCapabilityAvailable("invoicing")).toBe(false);
    expect(B.app.ctx.tools.isCapabilityAvailable("invoicing")).toBe(true);
    expect(B.app.ctx.tools.toolsFor({ level: "full", areas: ["orders"] }).some((t) => t.name === "orders_list")).toBe(true);
    expect(app.ctx.tools.toolsFor({ level: "full", areas: ["orders"] }).some((t) => t.name === "orders_list")).toBe(false);
  });

  it("shares the immutable built-in definitions but never the registries", async () => {
    const B = await startSecond(configAt(freshRoot()));
    expect(B.app.ctx.tools).not.toBe(app.ctx.tools);
    expect(B.app.ctx.tools.find("studio_get_summary")).toBe(app.ctx.tools.find("studio_get_summary")); // one frozen definition, two registries
    expect(Object.isFrozen(app.ctx.tools.find("studio_get_summary"))).toBe(true);
  });
});
