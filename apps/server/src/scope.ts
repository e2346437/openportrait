import type { FastifyReply, FastifyRequest } from "fastify";
import { shootScopeHooks } from "./extension-hooks.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The shoots this user is limited to, or null for an unlimited user. Set by an extension. */
    shootScope: string[] | null;
  }
}

/** Sign-in basics every limited user keeps: who am I, sign out, change password, and the public setup check. */
const BASICS = new Set(["GET /api/studio/auth/me", "POST /api/studio/auth/logout", "POST /api/studio/auth/password", "GET /api/studio/setup"]);

export function shootScopeFor(user: { id: string; role: string } | null): string[] | null {
  if (!user) return null;
  let scope: string[] | null = null;
  for (const hook of shootScopeHooks) {
    const ids = hook(user);
    if (ids) scope = [...(scope ?? []), ...ids];
  }
  return scope;
}

/**
 * Default-deny for limited users: they may use the sign-in basics, list their shoots, and read one of them.
 * Everything else under /api/studio answers 403, so a new route is closed to them until it is added here.
 */
export async function enforceShootScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const scope = req.shootScope;
  if (!scope) return;
  const path = req.url.split("?")[0]!.replace(/\/+$/, "");
  if (!path.startsWith("/api/studio")) return;
  if (BASICS.has(`${req.method} ${path}`)) return;
  if (req.method === "GET" && path === "/api/studio/shoots") return;
  const m = req.method === "GET" ? path.match(/^\/api\/studio\/shoots\/([^/]+)$/) : null;
  if (m && scope.includes(decodeURIComponent(m[1]!))) return;
  await reply.code(403).send({ error: "forbidden", message: "Your login can only open the shoots you're assigned to." });
}
