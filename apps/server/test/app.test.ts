import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { extractTunnelToken, friendlyTunnelError, hostnamesFromLog, parseTunnelToken } from "../src/tunnel.js";

let app: FastifyInstance;
let root: string;

const owner = { studioName: "Test Studio", ownerName: "Pat Doe", email: "Pat@Example.com", password: "correct horse battery", timezone: "America/Chicago" };
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((c) => c.name === "op_session");
  return c ? `op_session=${c.value}` : "";
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-app-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
});
afterEach(async () => {
  await app.close();
});

describe("setup", () => {
  it("reports that setup is needed, then creates the owner and signs them in", async () => {
    expect((await app.inject("/api/studio/setup")).json().needsSetup).toBe(true);
    const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("pat@example.com");
    const me = await app.inject({ url: "/api/studio/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json()).toMatchObject({ user: { name: "Pat Doe", role: "owner" }, studio: { name: "Test Studio" } });
    expect((await app.inject("/api/studio/setup")).json().needsSetup).toBe(false);
  });

  it("refuses a second setup", async () => {
    await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner });
    const again = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { ...owner, email: "x@example.com" } });
    expect(again.statusCode).toBe(409);
  });

  it("explains a short password", async () => {
    const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { ...owner, password: "short" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: "password", message: "Use at least 10 characters." });
  });
});

describe("auth", () => {
  beforeEach(async () => {
    await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner });
  });

  it("signs in with the right password and out again", async () => {
    const res = await app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "pat@example.com", password: owner.password } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    expect((await app.inject({ url: "/api/studio/settings/studio", headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/api/studio/auth/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/studio/settings/studio", headers: { cookie } })).statusCode).toBe(401);
  });

  it("rejects a wrong password without saying which part was wrong", async () => {
    const res = await app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "pat@example.com", password: "nope nope nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("That email and password don't match.");
  });

  it("protects settings from anonymous requests", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/studio/settings/studio", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/studio/internet" })).statusCode).toBe(401);
  });
});

describe("internet", () => {
  let cookie: string;
  beforeEach(async () => {
    cookie = cookieOf(await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner }));
  });

  it("accepts a token pasted as the whole install command", async () => {
    const token = Buffer.from(JSON.stringify({ a: "acct", t: "tunnel-id", s: "secret" })).toString("base64");
    const res = await app.inject({ method: "PUT", url: "/api/studio/internet/token", headers: { cookie }, payload: { token: `sudo cloudflared service install ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().tunnel.tokenSource).toBe("settings");
  });

  it("rejects something that isn't a token", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/studio/internet/token", headers: { cookie }, payload: { token: "hello" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/doesn't look like a tunnel token/);
  });

  it("normalizes the public address", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/studio/internet/public-url", headers: { cookie }, payload: { url: "studio.example.com/" } });
    expect(res.json().publicUrl).toBe("https://studio.example.com");
  });
});

describe("tunnel helpers", () => {
  it("parses a token", () => {
    const token = Buffer.from(JSON.stringify({ a: "acct", t: "tid", s: "s" })).toString("base64");
    expect(parseTunnelToken(token)).toEqual({ accountTag: "acct", tunnelId: "tid" });
    expect(parseTunnelToken("nope")).toBeNull();
  });
  it("explains common cloudflared errors in plain words", () => {
    expect(friendlyTunnelError('2026-11-01T18:55:15Z ERR Initiating shutdown error="Could not lookup srv records on _v2-origintunneld._tcp.argotunnel.com: lookup _v2-origintunneld._tcp.argotunnel.com on 8.8.8.8:53: no such host"')).toMatch(/DNS/);
    expect(friendlyTunnelError("2026-11-01T18:55:15Z ERR Register tunnel error from server side error=\"Unauthorized: Invalid tunnel secret\"")).toMatch(/rejected the tunnel token/);
    expect(friendlyTunnelError("2026-11-01T18:55:15Z ERR Something new")).toBe("Something new");
  });
  it("finds the token in any install command Cloudflare shows", () => {
    const token = Buffer.from(JSON.stringify({ a: "0123456789abcdef", t: "6ff42ae2-765d-4adf-8112-31c55c1551ef", s: "c2VjcmV0c2VjcmV0c2VjcmV0" })).toString("base64");
    for (const pasted of [
      token,
      `sudo cloudflared service install ${token}`,
      `cloudflared.exe service install ${token}`,
      `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${token}`,
      `TUNNEL_TOKEN="${token}"`,
      `TUNNEL_TOKEN=${token}`,
    ]) {
      expect(extractTunnelToken(pasted)).toBe(token);
    }
    expect(extractTunnelToken("cloudflared service install not-a-token")).toBeNull();
    const padded = Buffer.from(JSON.stringify({ a: "a", t: "t", s: "s", pad: "xxxxxxxxxxxxxxxx" })).toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(extractTunnelToken(`cloudflared service install ${padded}`)).toBe(padded);
  });

  it("reads hostnames from cloudflared's config log line", () => {
    const line = `2026-11-01T18:00:00Z INF Updated to new configuration config="{\\"ingress\\":[{\\"hostname\\":\\"studio.example.com\\",\\"service\\":\\"http://localhost:8080\\"},{\\"service\\":\\"http_status:404\\"}]}" version=3`;
    expect(hostnamesFromLog(line)).toEqual(["studio.example.com"]);
    expect(hostnamesFromLog("INF Registered tunnel connection")).toBeNull();
  });
});

describe("secrets", () => {
  it("stores the tunnel token encrypted", async () => {
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/studio/setup", payload: owner }));
    const token = Buffer.from(JSON.stringify({ a: "acct", t: "tid", s: "very-secret" })).toString("base64");
    await app.inject({ method: "PUT", url: "/api/studio/internet/token", headers: { cookie }, payload: { token } });
    const raw = app.ctx.db.$client.prepare("select value from setting where key = 'tunnel.token'").get() as { value: string };
    expect(raw.value).not.toContain(token);
    expect(app.ctx.settings.get("tunnel.token")).toBe(token);
  });
});
