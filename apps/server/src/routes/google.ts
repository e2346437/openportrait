import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth.js";
import { authUrl, exchangeCode, GoogleApiError, GoogleAuthError } from "../google/api.js";
import { apiFromSettings, runSync } from "../google/job.js";
import { disconnectGoogle, googleStatus, listChoices, setBusyCalendars } from "../google/sync.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const ClientBody = z.object({
  clientId: z.string().trim().min(10, "Paste the client ID from Google Cloud.").max(300),
  clientSecret: z.string().trim().max(300).optional(),
});

export async function googleRoutes(app: FastifyInstance) {
  const { settings, db } = app.ctx;
  app.addHook("preHandler", requireOwner);
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  const redirectUri = () => `${app.ctx.publicUrl().replace(/\/+$/, "")}/api/studio/google/callback`;
  const fail = (reply: Parameters<typeof parse>[2], status: number, message: string) => reply.code(status).send({ error: "google", message });

  app.get("/", async () => ({
    ...googleStatus({ db, settings, config: app.ctx.config, actorId: null }),
    clientId: settings.get("google.clientId") ?? "",
    hasSecret: !!settings.get("google.clientSecret"),
    redirectUri: redirectUri(),
    hasPublicUrl: !!app.ctx.publicUrl(),
  }));

  app.put("/client", async (req, reply) => {
    const body = parse(ClientBody, req.body, reply);
    if (!body) return;
    if (!body.clientSecret && !settings.get("google.clientSecret")) return fail(reply, 400, "Paste the client secret from Google Cloud.");
    const changed = settings.get("google.clientId") !== body.clientId;
    settings.set("google.clientId", body.clientId);
    if (body.clientSecret) settings.set("google.clientSecret", body.clientSecret);
    if (changed && settings.get("google.refreshToken")) disconnectGoogle(ctx(req));
    return { ok: true };
  });

  app.post("/connect", async (req, reply) => {
    const clientId = settings.get("google.clientId");
    const clientSecret = settings.get("google.clientSecret");
    if (!clientId || !clientSecret) return fail(reply, 400, "Save your Google client ID and secret first.");
    if (!app.ctx.publicUrl()) return fail(reply, 400, "Set your public address in Settings > Internet access first. Google needs it to send you back here.");
    const state = crypto.randomBytes(24).toString("base64url");
    settings.set("google.oauthState", `${state}.${Date.now()}`);
    return { url: authUrl({ clientId, clientSecret }, redirectUri(), state) };
  });

  // Google sends the browser back here. The signed-in owner's cookie identifies who is connecting.
  app.get("/callback", async (req, reply) => {
    const back = (q: string) => reply.redirect(`/studio/settings/calendar?${q}`);
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return back(`google_error=${encodeURIComponent(q.error === "access_denied" ? "You chose not to allow access." : q.error)}`);
    const [saved, at] = (settings.get("google.oauthState") ?? "").split(".");
    settings.delete("google.oauthState");
    const fresh = Number(at) > Date.now() - 15 * 60_000;
    const a = Buffer.from(q.state ?? "");
    const b = Buffer.from(saved ?? "");
    if (!q.code || !fresh || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return back("google_error=" + encodeURIComponent("That sign-in link expired. Try connecting again."));
    const clientId = settings.get("google.clientId");
    const clientSecret = settings.get("google.clientSecret");
    if (!clientId || !clientSecret) return back("google_error=" + encodeURIComponent("Save your client ID and secret first."));
    try {
      const { refreshToken, email } = await exchangeCode({ clientId, clientSecret }, redirectUri(), q.code);
      settings.set("google.refreshToken", refreshToken);
      if (email) settings.set("google.email", email);
      settings.delete("google.needsReconnect");
      settings.delete("google.lastError");
    } catch (err) {
      return back("google_error=" + encodeURIComponent(err instanceof Error ? err.message : "Google sign-in failed."));
    }
    // First sync in the background so the redirect is quick.
    const api = apiFromSettings(settings);
    if (api) void runSync(ctx(req), api).catch((e) => req.log.error(e));
    return back("google=connected");
  });

  const needApi = (reply: Parameters<typeof parse>[2]) => {
    const api = apiFromSettings(settings);
    if (!api) fail(reply, 400, "Google Calendar isn't connected.");
    return api;
  };
  const googleError = (reply: Parameters<typeof parse>[2], err: unknown) => {
    if (err instanceof GoogleAuthError) {
      settings.set("google.needsReconnect", true);
      return fail(reply, 401, err.message);
    }
    return fail(reply, 502, err instanceof GoogleApiError || err instanceof Error ? err.message : "Google didn't answer.");
  };

  app.get("/calendars", async (req, reply) => {
    const api = needApi(reply);
    if (!api) return;
    try {
      return { calendars: await listChoices(ctx(req), api) };
    } catch (err) {
      return googleError(reply, err);
    }
  });
  app.put("/calendars", async (req, reply) => {
    const body = parse(z.object({ calendars: z.array(z.object({ id: z.string().max(300), name: z.string().max(300) })).max(50) }), req.body, reply);
    if (!body) return;
    setBusyCalendars(ctx(req), body.calendars);
    return { ok: true };
  });
  app.post("/sync", async (req, reply) => {
    const api = needApi(reply);
    if (!api) return;
    const out = await runSync(ctx(req), api);
    if (!out.ok) return fail(reply, settings.get("google.needsReconnect") ? 401 : 502, out.message);
    return out.result;
  });
  app.delete("/", async (req) => {
    disconnectGoogle(ctx(req));
    return { ok: true };
  });

}
