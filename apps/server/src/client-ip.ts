import type { FastifyRequest } from "fastify";

/**
 * The real visitor IP. Behind Cloudflare, the socket address is cloudflared's, so we use
 * CF-Connecting-IP when trusting Cloudflare is on. LAN requests have no such header.
 */
export function clientIp(req: FastifyRequest, trustCloudflare: boolean): string {
  const cf = req.headers["cf-connecting-ip"];
  if (trustCloudflare && typeof cf === "string" && cf.length > 0 && cf.length < 64) return cf;
  return req.socket.remoteAddress ?? "unknown";
}

export function viaCloudflare(req: FastifyRequest): boolean {
  return typeof req.headers["cf-ray"] === "string";
}
