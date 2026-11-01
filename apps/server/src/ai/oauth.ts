import crypto from "node:crypto";
import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { requireOwner } from "../auth.js";
import { parse } from "../validate.js";
import { TOKEN_PREFIX } from "./connections.js";
import { AREAS } from "./registry.js";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const rnd = (bytes: number) => crypto.randomBytes(bytes).toString("base64url");
const ACCESS_SECONDS = 3600;
const CODE_MINUTES = 10;
const MAX_CLIENTS = 500;

/** Loopback http is allowed for desktop apps; everything else must be https. */
function validRedirect(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const u = new URL(uri);
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

const oauthError = (reply: FastifyReply, error: string, description: string, status = 400) =>
  reply.code(status).header("Cache-Control", "no-store").send({ error, error_description: description });

/**
 * OAuth 2.1 authorization server for the MCP endpoint (authorization code with PKCE, dynamic client
 * registration, rotating refresh tokens). This is what lets Claude and ChatGPT connectors sign in with
 * one pasted URL. Public paths with their own authentication.
 */
export async function oauthRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db, settings } = ctx;

  const base = (req: FastifyRequest) => ctx.publicUrl() || `${(req.headers["x-forwarded-proto"] as string) ?? "http"}://${req.headers.host}`;
  const enabled = (reply: FastifyReply) => (settings.get("ai.enabled") ? true : (void reply.code(404).send({ error: "not_found" }), false));

  // Form-encoded bodies, which the token endpoint receives.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16_384 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Browser-based MCP clients read the metadata and call the token endpoint cross-origin (no cookies involved).
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/.well-known/") || req.url.startsWith("/oauth/token") || req.url.startsWith("/oauth/register")) {
      reply.header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
      if (req.method === "OPTIONS") return reply.code(204).send();
    }
  });

  for (const path of ["/.well-known/*", "/oauth/token", "/oauth/register"]) app.options(path, async (_req, reply) => reply.code(204).send());

  const resourceMetadata = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!enabled(reply)) return;
    return { resource: `${base(req)}/mcp`, authorization_servers: [base(req)], bearer_methods_supported: ["header"] };
  };
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

  app.get("/.well-known/oauth-authorization-server", async (req, reply) => {
    if (!enabled(reply)) return;
    const b = base(req);
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  });

  const Register = z.object({
    client_name: z.string().trim().max(80).optional(),
    redirect_uris: z.array(z.string().max(500)).min(1).max(5),
  });
  app.post("/oauth/register", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!enabled(reply)) return;
    const body = Register.safeParse(req.body);
    if (!body.success || !body.data.redirect_uris.every(validRedirect)) {
      return oauthError(reply, "invalid_redirect_uri", "Redirect addresses must be https (or http on localhost) and have no fragment.");
    }
    // Unused registrations are the only thing an anonymous caller can create, so keep them bounded.
    db.delete(tables.oauthClient)
      .where(and(lt(tables.oauthClient.createdAt, new Date(Date.now() - 30 * 86_400_000)), notExists(db.select({ x: sql`1` }).from(tables.aiConnection).where(eq(tables.aiConnection.clientId, tables.oauthClient.id)))))
      .run();
    if ((db.select({ n: sql<number>`count(*)` }).from(tables.oauthClient).get()?.n ?? 0) >= MAX_CLIENTS) return oauthError(reply, "temporarily_unavailable", "Too many registered apps. Try again later.", 503);
    const client = db
      .insert(tables.oauthClient)
      .values({ id: `opc_${rnd(16)}`, name: body.data.client_name || "AI assistant", redirectUris: body.data.redirect_uris })
      .returning()
      .get();
    return reply.code(201).header("Cache-Control", "no-store").send({
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // The client sends the person's browser here. After validating, hand over to the consent screen,
  // which needs the owner signed in (the studio app handles that).
  app.get("/oauth/authorize", async (req, reply) => {
    if (!enabled(reply)) return;
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? db.select().from(tables.oauthClient).where(eq(tables.oauthClient.id, q.client_id)).get() : undefined;
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return reply.code(400).type("text/plain").send("This sign-in link isn't valid. Start again from your AI app.");
    }
    const back = (error: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set("error", error);
      if (q.state) u.searchParams.set("state", q.state);
      return reply.redirect(u.toString());
    };
    if (q.response_type !== "code") return back("unsupported_response_type");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request");
    const params = new URLSearchParams({ client_id: client.id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, ...(q.state ? { state: q.state } : {}) });
    return reply.header("Cache-Control", "no-store").redirect(`/studio/connect/consent?${params}`);
  });

  const Token = z.object({
    grant_type: z.enum(["authorization_code", "refresh_token"]),
    client_id: z.string(),
    code: z.string().optional(),
    code_verifier: z.string().min(43).max(128).optional(),
    redirect_uri: z.string().optional(),
    refresh_token: z.string().optional(),
  });

  const issue = (reply: FastifyReply, access: string, refresh: string) =>
    reply.header("Cache-Control", "no-store").send({ access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh });

  app.post("/oauth/token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!enabled(reply)) return;
    const body = Token.safeParse(req.body);
    if (!body.success) return oauthError(reply, "invalid_request", "Missing or malformed parameters.");
    const t = body.data;

    if (t.grant_type === "authorization_code") {
      if (!t.code || !t.code_verifier || !t.redirect_uri) return oauthError(reply, "invalid_request", "code, code_verifier and redirect_uri are required.");
      const row = db.select().from(tables.oauthCode).where(eq(tables.oauthCode.id, sha256(t.code))).get();
      if (row) db.delete(tables.oauthCode).where(eq(tables.oauthCode.id, row.id)).run(); // one use only, pass or fail
      const challenge = crypto.createHash("sha256").update(t.code_verifier).digest("base64url");
      if (!row || row.expiresAt.getTime() < Date.now() || row.clientId !== t.client_id || row.redirectUri !== t.redirect_uri || row.codeChallenge !== challenge) {
        return oauthError(reply, "invalid_grant", "The sign-in expired or doesn't match. Start again from your AI app.");
      }
      const client = db.select().from(tables.oauthClient).where(eq(tables.oauthClient.id, row.clientId)).get();
      const access = TOKEN_PREFIX + rnd(32);
      const refresh = `opr_${rnd(32)}`;
      db.insert(tables.aiConnection)
        .values({
          id: crypto.randomUUID(),
          label: row.label || client?.name || "AI assistant",
          kind: "oauth",
          tokenHash: sha256(access),
          tokenHint: access.slice(-4),
          level: row.level,
          areas: row.areas,
          createdBy: row.userId,
          clientId: row.clientId,
          accessExpiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000),
          refreshHash: sha256(refresh),
        })
        .run();
      return issue(reply, access, refresh);
    }

    if (!t.refresh_token) return oauthError(reply, "invalid_request", "refresh_token is required.");
    const hash = sha256(t.refresh_token);
    const replayed = db.select().from(tables.aiConnection).where(eq(tables.aiConnection.refreshPrevHash, hash)).get();
    if (replayed) {
      // An old refresh token came back: a copy leaked. Cut the connection off.
      db.update(tables.aiConnection).set({ revokedAt: new Date() }).where(eq(tables.aiConnection.id, replayed.id)).run();
      db.insert(tables.auditLog).values({ actorType: "system", connectionId: replayed.id, action: "ai.connection.revoke", detail: { reason: "refresh token reuse" } }).run();
      return oauthError(reply, "invalid_grant", "This sign-in was revoked. Connect again from your AI app.");
    }
    const conn = db.select().from(tables.aiConnection).where(and(eq(tables.aiConnection.refreshHash, hash), isNull(tables.aiConnection.revokedAt))).get();
    if (!conn || conn.clientId !== t.client_id) return oauthError(reply, "invalid_grant", "The refresh token isn't valid. Connect again from your AI app.");
    const access = TOKEN_PREFIX + rnd(32);
    const refresh = `opr_${rnd(32)}`;
    db.update(tables.aiConnection)
      .set({ tokenHash: sha256(access), tokenHint: access.slice(-4), accessExpiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000), refreshHash: sha256(refresh), refreshPrevHash: hash })
      .where(eq(tables.aiConnection.id, conn.id))
      .run();
    return issue(reply, access, refresh);
  });
}

const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid sign-in request.");
const Decision = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: Challenge,
  state: z.string().max(500).optional(),
  approve: z.boolean(),
  label: z.string().trim().max(80).optional(),
  level: z.enum(["read", "assist", "full"]).default("read"),
  areas: z.array(z.enum(AREAS)).default(["studio"]),
});

/** The consent screen's API: owner only, under /api/studio so it follows the staff session rules. */
export async function oauthStudioRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const findClient = (id: string, redirect: string) => {
    const c = db.select().from(tables.oauthClient).where(eq(tables.oauthClient.id, id)).get();
    return c && c.redirectUris.includes(redirect) ? c : undefined;
  };

  app.get("/request", { preHandler: requireOwner }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const client = findClient(q.client_id ?? "", q.redirect_uri ?? "");
    if (!client) return reply.code(400).send({ error: "invalid", message: "This sign-in link isn't valid. Start again from your AI app." });
    return { clientName: client.name, redirectHost: new URL(q.redirect_uri!).host };
  });

  app.post("/decision", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(Decision, req.body, reply);
    if (!body) return;
    const client = findClient(body.client_id, body.redirect_uri);
    if (!client) return reply.code(400).send({ error: "invalid", message: "This sign-in link isn't valid. Start again from your AI app." });
    const target = new URL(body.redirect_uri);
    if (body.state) target.searchParams.set("state", body.state);
    if (!body.approve) {
      target.searchParams.set("error", "access_denied");
      return { redirectTo: target.toString() };
    }
    const code = rnd(32);
    db.delete(tables.oauthCode).where(lt(tables.oauthCode.expiresAt, new Date())).run();
    db.insert(tables.oauthCode)
      .values({ id: sha256(code), clientId: client.id, redirectUri: body.redirect_uri, codeChallenge: body.code_challenge, label: body.label || client.name, level: body.level, areas: body.areas, userId: req.user!.id, expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) })
      .run();
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "ai.connection.authorize", detail: { client: client.name, level: body.level }, ip: app.ctx.ip(req) }).run();
    target.searchParams.set("code", code);
    return { redirectTo: target.toString() };
  });
}
