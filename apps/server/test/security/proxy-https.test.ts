import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { requestIsHttps } from "../../src/client-ip.js";

function request(address: string, headers: FastifyRequest["headers"] = {}, protocol = "http") {
  return { protocol, socket: { remoteAddress: address }, headers } as FastifyRequest;
}

describe("HTTPS trust for cookies and HSTS", () => {
  it("accepts direct TLS and preserves plain LAN access", () => {
    expect(requestIsHttps(request("192.168.1.50", {}, "https"), [])).toBe(true);
    expect(requestIsHttps(request("192.168.1.50"), [])).toBe(false);
  });

  it("accepts HTTPS forwarding only from a trusted peer", () => {
    const headers = { "x-forwarded-proto": "https", "cf-ray": "synthetic" };
    expect(requestIsHttps(request("127.0.0.1", headers), [])).toBe(true);
    expect(requestIsHttps(request("172.18.0.4", headers), ["172.18.0.4"])).toBe(true);
    expect(requestIsHttps(request("172.18.0.5", headers), ["172.18.0.4"])).toBe(false);
    expect(requestIsHttps(request("127.0.0.1", { "cf-ray": "synthetic" }), [])).toBe(false);
  });
});
