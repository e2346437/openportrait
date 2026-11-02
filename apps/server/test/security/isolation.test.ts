import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { boot, control, json, type Deployment } from "./harness.js";

/** Two synthetic photographers, each with its own data folder, as the hosted edition would run them. */
let a: Deployment;
let b: Deployment;
beforeAll(async () => {
  a = await boot("iso-a");
  b = await boot("iso-b");
});
afterAll(async () => {
  await a.close();
  await b.close();
});

describe("deployment isolation (application layer)", () => {
  control("ISO-1", "each deployment generates its own secret key and instance id", async () => {
    const keyA = fs.readFileSync(path.join(a.root, "config", "secret.key"), "utf8");
    const keyB = fs.readFileSync(path.join(b.root, "config", "secret.key"), "utf8");
    expect(keyA).not.toBe(keyB);
    expect(json(await a.app.inject("/api/health")).instanceId).not.toBe(json(await b.app.inject("/api/health")).instanceId);
  });

  control("ISO-2", "a staff session from one deployment means nothing to the other", async () => {
    const res = await b.app.inject({ url: "/api/studio/auth/me", headers: { cookie: a.cookie } });
    expect(res.json().user).toBeNull();
    expect((await b.app.inject({ url: "/api/studio/galleries", headers: { cookie: a.cookie } })).statusCode).toBe(401);
  });

  control("ISO-3", "an AI token from one deployment is rejected by the other", async () => {
    for (const x of [a, b]) await x.app.inject({ method: "PUT", url: "/api/studio/ai", headers: { cookie: x.cookie, "content-type": "application/json" }, payload: { enabled: true } });
    const created = await a.app.inject({ method: "POST", url: "/api/studio/ai/connections", headers: { cookie: a.cookie, "content-type": "application/json" }, payload: { label: "t", level: "full", areas: ["studio"] } });
    const token = json(created).token as string;
    const ask = (x: Deployment) => x.app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect((await ask(a)).statusCode).toBe(200);
    expect((await ask(b)).statusCode).toBe(401);
  });

  control("ISO-4", "signatures made by one deployment (media URLs, client cookies) do not verify on the other", async () => {
    const sa = a.app.ctx.secrets;
    const sb = b.app.ctx.secrets;
    const sig = sa.sign("media", "photo:1:thumb");
    expect(sa.verify("media", "photo:1:thumb", sig)).toBe(true);
    expect(sb.verify("media", "photo:1:thumb", sig)).toBe(false);
    expect(sb.verify("client", "someone@audit.invalid", sa.sign("client", "someone@audit.invalid"))).toBe(false);
  });

  control("ISO-5", "stored secrets encrypted by one deployment can't be opened by the other", () => {
    const box = a.app.ctx.secrets.encrypt("synthetic-paypal-secret");
    expect(a.app.ctx.secrets.decrypt(box)).toBe("synthetic-paypal-secret");
    expect(() => b.app.ctx.secrets.decrypt(box)).toThrow();
  });

  control("ISO-6", "separate databases: a record created in one never appears in the other", async () => {
    await a.app.inject({ method: "POST", url: "/api/studio/contacts", headers: { cookie: a.cookie, "content-type": "application/json" }, payload: { firstName: "OnlyInA", email: "only-a@audit.invalid" } });
    const inA = await a.app.inject({ url: "/api/studio/contacts?q=OnlyInA", headers: { cookie: a.cookie } });
    const inB = await b.app.inject({ url: "/api/studio/contacts?q=OnlyInA", headers: { cookie: b.cookie } });
    expect(inA.body).toContain("OnlyInA");
    expect(inB.body).not.toContain("OnlyInA");
  });
});
