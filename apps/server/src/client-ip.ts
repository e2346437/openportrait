import net from "node:net";
import type { FastifyRequest } from "fastify";

/**
 * Where a request really came from.
 *
 * Behind the built-in Cloudflare tunnel the socket address is cloudflared on loopback, so the visitor's address is in
 * CF-Connecting-IP. That header is only believed when the connection itself comes from a trusted proxy: loopback, or an
 * address listed in TRUSTED_PROXIES (comma separated IPs or IPv4 CIDRs, for cloudflared running in a separate
 * container). A caller who reaches the port directly can send any header, so from anyone else it is ignored and the
 * socket address is used. Rate limits key on this value (SEC-001).
 */
const extra = (process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const stripMapped = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base) return false;
  if (bitsRaw === undefined) return stripMapped(ip) === stripMapped(base);
  if (net.isIPv4(base) && net.isIPv4(stripMapped(ip))) {
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const toInt = (a: string) => a.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(stripMapped(ip)) & mask) === (toInt(base) & mask);
  }
  return false;
}

export function isTrustedProxy(socketIp: string | undefined, trusted: string[] = extra): boolean {
  if (!socketIp) return false;
  const ip = stripMapped(socketIp);
  if (ip === "127.0.0.1" || ip === "::1") return true;
  return trusted.some((c) => inCidr(ip, c));
}

export function clientIp(req: FastifyRequest, trustCloudflare: boolean, trusted?: string[]): string {
  const socketIp = req.socket.remoteAddress;
  const cf = req.headers["cf-connecting-ip"];
  if (trustCloudflare && isTrustedProxy(socketIp, trusted) && typeof cf === "string" && net.isIP(cf.trim()) !== 0) return cf.trim();
  return socketIp ?? "unknown";
}

export function viaCloudflare(req: FastifyRequest): boolean {
  return typeof req.headers["cf-ray"] === "string";
}
