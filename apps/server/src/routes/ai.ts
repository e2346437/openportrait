import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { AREAS, allTools } from "../ai/registry.js";
import { createConnection, listConnections, revokeConnection } from "../ai/connections.js";
import "../ai/tools/index.js";
import { decide, listApprovals, pendingCount } from "../ai/approvals.js";
import { requireOwner, verifyPassword } from "../auth.js";
import { clearCode, hasCode, setCode, suggestCode } from "../ai/authcode.js";
import { parse } from "../validate.js";

const SettingsBody = z.object({ enabled: z.boolean().optional(), paused: z.boolean().optional() });
const CreateBody = z.object({
  label: z.string().trim().min(1, "Give this connection a name, like “Claude Code on my laptop”.").max(80),
  level: z.enum(["read", "assist", "full"]),
  areas: z.array(z.enum(AREAS)).min(1, "Choose at least one area."),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});

export async function aiRoutes(app: FastifyInstance) {
  const { settings, db, config, tunnel } = app.ctx;

  const lanMcpUrl = () => {
    const lan = app.ctx.lan();
    if (lan.url) return `${lan.url}/mcp`;
    return lan.addresses[0] ? `http://${lan.addresses[0]}:${config.port}/mcp` : null;
  };

  const status = () => {
    const base = app.ctx.publicUrl();
    const connections = listConnections(db);
    return {
      enabled: settings.get("ai.enabled") ?? false,
      paused: settings.get("ai.paused") ?? false,
      urls: { public: base ? `${base}/mcp` : null, lan: lanMcpUrl() },
      online: tunnel.getStatus().state === "connected",
      areas: AREAS,
      toolCount: allTools().length,
      authCode: { set: hasCode(app.ctx), setAt: settings.get("ai.authCodeSetAt") || null },
      connections,
      lastSeenAt: connections.reduce<number | null>((m, c) => (c.lastUsedAt && (!m || c.lastUsedAt > m) ? c.lastUsedAt : m), null),
    };
  };

  app.get("/", { preHandler: requireOwner }, async () => status());

  app.put("/", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(SettingsBody, req.body, reply);
    if (!body) return;
    if (body.enabled !== undefined) settings.set("ai.enabled", body.enabled);
    if (body.paused !== undefined) settings.set("ai.paused", body.paused);
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "ai.settings", detail: body, ip: app.ctx.ip(req) }).run();
    return status();
  });

  app.post("/connections", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(CreateBody, req.body, reply);
    if (!body) return;
    const created = createConnection(db, { ...body, userId: req.user!.id });
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "ai.connection.create", detail: { id: created.connection.id, label: body.label, level: body.level }, ip: app.ctx.ip(req) }).run();
    return { ...created, status: status() };
  });

  app.delete<{ Params: { id: string } }>("/connections/:id", { preHandler: requireOwner }, async (req, reply) => {
    if (!revokeConnection(db, req.params.id)) return reply.code(404).send({ error: "not_found", message: "That connection no longer exists." });
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "ai.connection.revoke", detail: { id: req.params.id }, ip: app.ctx.ip(req) }).run();
    return status();
  });

  // Authorization code for sensitive AI actions. The code itself is never returned; only a fresh suggestion is.
  app.get("/auth-code/suggest", { preHandler: requireOwner }, async () => ({ code: suggestCode() }));

  const CodeBody = z.object({ code: z.string().min(1, "Enter a code."), password: z.string().optional() });
  const owner = (id: string) => db.select().from(tables.user).where(eq(tables.user.id, id)).get();
  /** Changing or removing an existing code needs the owner's password again, as a stolen session must not be able to swap it. */
  const reauth = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, password: string | undefined) => {
    if (!hasCode(app.ctx)) return true;
    const u = owner(req.user!.id);
    if (!password || !u || !(await verifyPassword(u.passwordHash, password))) {
      reply.code(400).send({ error: "invalid", field: "password", message: "Enter your password to change the authorization code." });
      return false;
    }
    return true;
  };

  app.put("/auth-code", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(CodeBody, req.body, reply);
    if (!body || !(await reauth(req, reply, body.password))) return;
    try {
      await setCode(app.ctx, body.code);
    } catch (err) {
      return reply.code(400).send({ error: "invalid", field: "code", message: (err as Error).message });
    }
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "ai.authcode.set", ip: app.ctx.ip(req) }).run();
    return status();
  });

  app.delete("/auth-code", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ password: z.string().optional() }), req.body ?? {}, reply);
    if (!body || !(await reauth(req, reply, body.password))) return;
    clearCode(app.ctx);
    db.insert(tables.auditLog).values({ userId: req.user!.id, action: "ai.authcode.cleared", ip: app.ctx.ip(req) }).run();
    return status();
  });

  app.get("/activity", { preHandler: requireOwner }, async () => {
    const rows = db.select().from(tables.auditLog).where(eq(tables.auditLog.actorType, "ai")).orderBy(desc(tables.auditLog.at)).limit(50).all();
    const labels = new Map(db.select({ id: tables.aiConnection.id, label: tables.aiConnection.label }).from(tables.aiConnection).all().map((c) => [c.id, c.label]));
    return {
      items: rows.map((r) => ({ id: r.id, at: r.at.getTime(), connection: labels.get(r.connectionId ?? "") ?? "Removed connection", action: r.action.replace(/^mcp\./, ""), ok: (r.detail as { ok?: boolean } | null)?.ok !== false })),
    };
  });

  app.get("/approvals", { preHandler: requireOwner }, async (req) => {
    const status = (req.query as { status?: string }).status;
    return { items: listApprovals(app.ctx, status === "pending" ? "pending" : undefined) };
  });

  // The sidebar badge asks this every so often, so keep it cheap.
  app.get("/approvals/summary", { preHandler: requireOwner }, async () => ({ enabled: settings.get("ai.enabled") ?? false, pending: pendingCount(app.ctx) }));

  for (const [path, approve] of [["approve", true], ["decline", false]] as const) {
    app.post<{ Params: { id: string } }>(`/approvals/:id/${path}`, { preHandler: requireOwner }, async (req, reply) => {
      try {
        return await decide(app.ctx, req.params.id, req.user!.id, approve);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply.code(e.statusCode ?? 500).send({ error: "approval", message: e.message });
      }
    });
  }
}
