import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth.js";
import { lanAddresses } from "../app.js";
import { extractTunnelToken } from "../tunnel.js";
import { parse } from "../validate.js";

const TokenBody = z.object({
  token: z
    .string()
    .trim()
    .transform((t) => extractTunnelToken(t) ?? "")
    .refine((t) => t !== "", "That doesn't look like a tunnel token. In Cloudflare, copy the whole install command shown for your tunnel, or just the long value starting with eyJ."),
});
const UrlBody = z.object({
  url: z
    .string()
    .trim()
    .transform((u) => (u === "" || /^https?:\/\//.test(u) ? u : `https://${u}`).replace(/\/+$/, ""))
    .refine((u) => u === "" || URL.canParse(u), "Enter an address like https://studio.example.com."),
});
const TrustBody = z.object({ trustCloudflare: z.boolean() });

export async function internetRoutes(app: FastifyInstance) {
  const { settings, tunnel, config, secrets } = app.ctx;

  const status = () => {
    const t = tunnel.getStatus();
    const savedToken = settings.get("tunnel.token");
    return {
      tunnel: { ...t, tokenSource: savedToken ? "settings" : config.tunnelToken ? "template" : null },
      publicUrl: app.ctx.publicUrl(),
      publicUrlSource: settings.get("internet.publicUrl") ? "settings" : config.appUrl ? "template" : t.hostnames[0] ? "tunnel" : null,
      trustCloudflare: settings.get("internet.trustCloudflare") ?? true,
      lan: { addresses: lanAddresses(), port: config.port },
      platform: config.isUnraid ? "unraid" : "docker",
    };
  };

  app.get("/", { preHandler: requireOwner }, async () => status());

  app.put("/token", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(TokenBody, req.body, reply);
    if (!body) return;
    settings.set("tunnel.token", body.token);
    tunnel.setToken(body.token);
    return status();
  });

  app.delete("/token", { preHandler: requireOwner }, async () => {
    settings.delete("tunnel.token");
    tunnel.setToken(config.tunnelToken);
    return status();
  });

  app.put("/public-url", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(UrlBody, req.body, reply);
    if (!body) return;
    if (body.url) settings.set("internet.publicUrl", body.url);
    else settings.delete("internet.publicUrl");
    return status();
  });

  app.put("/trust-cloudflare", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(TrustBody, req.body, reply);
    if (!body) return;
    settings.set("internet.trustCloudflare", body.trustCloudflare);
    return status();
  });

  /** End-to-end check: can this server reach itself through its public address? */
  app.post("/check", { preHandler: requireOwner, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async () => {
    const url = app.ctx.publicUrl();
    if (!url) return { ok: false, code: "no_url", message: "Add your public address first." };
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000), redirect: "follow", headers: { "cache-control": "no-cache" } });
      if (res.status === 530) {
        return { ok: false, code: "tunnel_down", message: "Cloudflare can't reach the tunnel. Check that it shows Connected above." };
      }
      if (res.status === 502) {
        return { ok: false, code: "bad_origin", message: "The tunnel is up but points at the wrong place. In Cloudflare, set the service to http://localhost:8080." };
      }
      if (res.status === 403 || res.redirected) {
        return { ok: false, code: "blocked", message: "Something in front of OpenPortrait (often a Cloudflare Access rule) blocked the check. Exclude /api/health from Access, or ignore this if you protect the whole site on purpose." };
      }
      const body = (await res.json().catch(() => null)) as { instanceId?: string } | null;
      if (!res.ok || !body) return { ok: false, code: "unexpected", message: `The address answered with HTTP ${res.status}, not OpenPortrait.` };
      if (body.instanceId !== secrets.instanceId()) {
        return { ok: false, code: "other_instance", message: "That address reaches a different OpenPortrait install. Check the hostname in your tunnel." };
      }
      return { ok: true, code: "ok", message: `Clients can reach your studio at ${url}.` };
    } catch (err) {
      const msg = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
      return { ok: false, code: "unreachable", message: `Looking up ${new URL(url).host} ${msg}. Check the hostname in Cloudflare and give DNS a minute to update.` };
    }
  });
}
