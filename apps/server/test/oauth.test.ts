import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let cookie: string;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-oauth-"));
  app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") }), startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Test Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  await app.inject({ method: "PUT", url: "/api/studio/ai", payload: { enabled: true }, headers: { cookie } });
});
afterEach(async () => {
  await app.close();
});

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

async function register(redirect = REDIRECT) {
  const res = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude", redirect_uris: [redirect] } });
  return res;
}
async function authorize(clientId: string, opts: { approve?: boolean; level?: string; areas?: string[] } = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/studio/oauth/decision",
    headers: { cookie },
    payload: { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: "xyz", approve: opts.approve ?? true, level: opts.level ?? "read", areas: opts.areas ?? ["studio"] },
  });
  return res;
}
const token = (body: Record<string, string>) => app.inject({ method: "POST", url: "/oauth/token", payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const codeFrom = (redirectTo: string) => new URL(redirectTo).searchParams.get("code")!;
const tools = (access: string) =>
  app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${access}` } });

async function signIn() {
  const clientId = (await register()).json().client_id as string;
  const { redirectTo } = (await authorize(clientId)).json();
  const res = await token({ grant_type: "authorization_code", client_id: clientId, code: codeFrom(redirectTo), code_verifier: verifier, redirect_uri: REDIRECT });
  return { clientId, res, body: res.json() };
}

describe("discovery", () => {
  it("publishes metadata that points at the endpoints, and tells unauthenticated clients where to look", async () => {
    const meta = (await app.inject("/.well-known/oauth-authorization-server")).json();
    expect(meta).toMatchObject({ code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    expect(meta.token_endpoint).toMatch(/\/oauth\/token$/);
    expect((await app.inject("/.well-known/oauth-protected-resource")).json().resource).toMatch(/\/mcp$/);
    const denied = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(denied.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("is hidden until AI access is on", async () => {
    await app.inject({ method: "PUT", url: "/api/studio/ai", payload: { enabled: false }, headers: { cookie } });
    expect((await app.inject("/.well-known/oauth-authorization-server")).statusCode).toBe(404);
    expect((await register()).statusCode).toBe(404);
  });
});

describe("registration", () => {
  it("accepts https and loopback redirects only", async () => {
    expect((await register()).statusCode).toBe(201);
    expect((await register("http://localhost:6274/callback")).statusCode).toBe(201);
    expect((await register("http://evil.example.com/cb")).statusCode).toBe(400);
    expect((await register("javascript:alert(1)")).statusCode).toBe(400);
  });
});

describe("authorize and token", () => {
  it("runs the whole flow and the access token works against /mcp", async () => {
    const { res, body } = await signIn();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(res.headers["cache-control"]).toBe("no-store");
    const list = await tools(body.access_token);
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toContain("studio_get_summary");
    const conns = (await app.inject({ url: "/api/studio/ai", headers: { cookie } })).json().connections;
    expect(conns[0]).toMatchObject({ kind: "oauth", label: "Claude", level: "read" });
  });

  it("sends the browser to the consent screen and rejects unknown redirects", async () => {
    const clientId = (await register()).json().client_id;
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const ok = await app.inject(`/oauth/authorize?${q}`);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toContain("/studio/connect/consent?");
    q.set("redirect_uri", "https://evil.example.com/cb");
    expect((await app.inject(`/oauth/authorize?${q}`)).statusCode).toBe(400);
    q.set("redirect_uri", REDIRECT);
    q.set("code_challenge_method", "plain");
    expect((await app.inject(`/oauth/authorize?${q}`)).headers.location).toContain("error=invalid_request");
  });

  it("returns access_denied to the client when the owner declines", async () => {
    const clientId = (await register()).json().client_id;
    const { redirectTo } = (await authorize(clientId, { approve: false })).json();
    expect(new URL(redirectTo).searchParams.get("error")).toBe("access_denied");
    expect(new URL(redirectTo).searchParams.get("state")).toBe("xyz");
  });

  it("only the owner can approve", async () => {
    const clientId = (await register()).json().client_id;
    const res = await app.inject({ method: "POST", url: "/api/studio/oauth/decision", payload: { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, approve: true } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong verifier, and a code can't be used twice", async () => {
    const clientId = (await register()).json().client_id;
    const code = codeFrom((await authorize(clientId)).json().redirectTo);
    const bad = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: crypto.randomBytes(32).toString("base64url"), redirect_uri: REDIRECT });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_grant");
    const retry = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(retry.statusCode).toBe(400);
  });

  it("rejects a code presented with a different redirect", async () => {
    const clientId = (await register()).json().client_id;
    const code = codeFrom((await authorize(clientId)).json().redirectTo);
    const res = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: "https://evil.example.com/cb" });
    expect(res.statusCode).toBe(400);
  });

  it("honours the access the owner chose on the consent screen", async () => {
    const clientId = (await register()).json().client_id;
    const code = codeFrom((await authorize(clientId, { level: "assist", areas: ["studio"] })).json().redirectTo);
    await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    const conns = (await app.inject({ url: "/api/studio/ai", headers: { cookie } })).json().connections;
    expect(conns[0]).toMatchObject({ level: "assist", areas: ["studio"] });
  });
});

describe("refresh tokens", () => {
  it("rotates, and the new access token works while the old one stops", async () => {
    const { clientId, body } = await signIn();
    const next = (await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: body.refresh_token })).json();
    expect(next.access_token).not.toBe(body.access_token);
    expect((await tools(next.access_token)).statusCode).toBe(200);
    expect((await tools(body.access_token)).statusCode).toBe(401);
  });

  it("revokes the connection if an old refresh token is replayed", async () => {
    const { clientId, body } = await signIn();
    const next = (await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: body.refresh_token })).json();
    expect((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: body.refresh_token })).statusCode).toBe(400);
    expect((await tools(next.access_token)).statusCode).toBe(401);
    expect((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: next.refresh_token })).statusCode).toBe(400);
  });

  it("stops when the owner disconnects", async () => {
    const { clientId, body } = await signIn();
    const id = (await app.inject({ url: "/api/studio/ai", headers: { cookie } })).json().connections[0].id;
    await app.inject({ method: "DELETE", url: `/api/studio/ai/connections/${id}`, headers: { cookie } });
    expect((await tools(body.access_token)).statusCode).toBe(401);
    expect((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: body.refresh_token })).statusCode).toBe(400);
  });

  it("expires access tokens after an hour", async () => {
    const { body } = await signIn();
    app.ctx.db.$client.prepare("UPDATE ai_connection SET access_expires_at = 1").run();
    expect((await tools(body.access_token)).statusCode).toBe(401);
  });
});
