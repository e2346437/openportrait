import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Cross-site request protection for the studio API (SEC-003).
 *
 * The session cookie is SameSite=Lax, which stops cross-site POSTs from other registrable domains but not from a
 * sibling subdomain (a studio at studio.example.com shares a site with blog.example.com). Browsers tell us who is
 * calling: Sec-Fetch-Site is set by the browser and can't be forged by a page, and Origin is the fallback for older
 * browsers. Requests carrying neither (curl, scripts, the camera tools) are not browser-driven and pass.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function crossSiteBlocked(req: FastifyRequest, allowedHosts: string[]): boolean {
  if (SAFE.has(req.method)) return false;
  if (!req.url.startsWith("/api/studio/")) return false;
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin || origin === "null") return origin === "null";
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const own = [String(req.headers.host ?? "").toLowerCase(), ...allowedHosts.map((h) => h.toLowerCase())];
  return !own.includes(host);
}

export function rejectCrossSite(reply: FastifyReply) {
  return reply.code(403).send({ error: "cross_site", message: "This request came from another website, so it was refused." });
}
