import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "@openportrait/config";
import { openDatabase, type Db } from "@openportrait/db";
import { JobRunner } from "@openportrait/jobs";
import { SESSION_COOKIE, lookupSession } from "./auth.js";
import { registerBackupJob } from "./backup.js";
import { clientIp } from "./client-ip.js";
import { Secrets } from "./secrets.js";
import { Settings } from "./settings.js";
import { TunnelManager } from "./tunnel.js";
import { mcpRoutes } from "./ai/mcp.js";
import { oauthRoutes, oauthStudioRoutes } from "./ai/oauth.js";
import { aiRoutes } from "./routes/ai.js";
import { automationRoutes } from "./routes/automation.js";
import { ensureDefaults } from "./domain/defaults.js";
import { DomainError } from "./domain/context.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { calendarRoutes } from "./routes/calendar.js";
import { googleRoutes } from "./routes/google.js";
import { bookingRoutes } from "./routes/booking.js";
import { publicRoutes } from "./routes/public.js";
import { registerEmailJob } from "./domain/email.js";
import { registerGoogleSyncJob } from "./google/job.js";
import { crmRoutes } from "./routes/crm.js";
import { internetRoutes } from "./routes/internet.js";
import { settingsRoutes } from "./routes/settings.js";
import { setupRoutes } from "./routes/setup.js";
import { tetherRoutes } from "./routes/tether.js";

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
/** The image tag when running the published image (set at build time), otherwise the package version. */
export const VERSION = process.env.OPENPORTRAIT_VERSION && process.env.OPENPORTRAIT_VERSION !== "dev" ? process.env.OPENPORTRAIT_VERSION.replace(/^v/, "") : PACKAGE_VERSION;

export interface AppContext {
  config: AppConfig;
  db: Db;
  secrets: Secrets;
  settings: Settings;
  tunnel: TunnelManager;
  jobs: JobRunner;
  /** Public base URL: setting, then APP_URL, then the tunnel's first hostname. */
  publicUrl(): string;
  ip(req: import("fastify").FastifyRequest): string;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildOptions {
  config: AppConfig;
  /** Tests pass false to skip timers and child processes. */
  startBackground?: boolean;
  logger?: boolean | object;
}

export async function buildApp({ config, startBackground = true, logger }: BuildOptions): Promise<FastifyInstance> {
  for (const dir of [config.configDir, config.cacheDir]) fs.mkdirSync(dir, { recursive: true });

  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    bodyLimit: 1024 * 1024,
  });

  const db = openDatabase({ file: path.join(config.configDir, "openportrait.db") });
  ensureDefaults(db);
  const secrets = Secrets.load(config.configDir);
  const settings = new Settings(db, secrets);
  const tunnel = new TunnelManager(app.log);
  const jobs = new JobRunner(db, { logger: app.log });

  const ctx: AppContext = {
    config,
    db,
    secrets,
    settings,
    tunnel,
    jobs,
    publicUrl() {
      const host = tunnel.getStatus().hostnames[0];
      return settings.get("internet.publicUrl") || config.appUrl || (host ? `https://${host}` : "");
    },
    ip(req) {
      return clientIp(req, settings.get("internet.trustCloudflare") ?? true);
    },
  };
  app.decorate("ctx", ctx);

  registerEmailJob(() => settings);
  const requestSync = registerGoogleSyncJob({ config: () => config, settings: () => settings });

  // A change to a shoot or the calendar reaches Google within seconds. The timer below is the backstop.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || reply.statusCode >= 300) return;
    if (/^\/api\/studio\/(shoots|calendar|leads)/.test(req.url)) requestSync(db);
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? lookupSession(db, token) : null;
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    return payload;
  });

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown; message: string }, req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "server_error" : "bad_request", message: status >= 500 ? "Something went wrong on the server. Check the container log for details." : err.message });
  });

  // The container health check calls this every 30 seconds, so keep it out of the info log.
  app.get("/api/health", { logLevel: "warn" }, async () => ({ ok: true, version: VERSION, instanceId: secrets.instanceId() }));

  // Staff-only API lives under /api/studio and the staff UI under /studio. Staff sign in with the
  // OpenPortrait login; client pages stay public.
  await app.register(setupRoutes, { prefix: "/api/studio/setup" });
  await app.register(authRoutes, { prefix: "/api/studio/auth" });
  await app.register(settingsRoutes, { prefix: "/api/studio/settings" });
  await app.register(internetRoutes, { prefix: "/api/studio/internet" });
  await app.register(catalogRoutes, { prefix: "/api/studio" });
  await app.register(crmRoutes, { prefix: "/api/studio" });
  await app.register(tetherRoutes, { prefix: "/api/studio/tether" });
  await app.register(calendarRoutes, { prefix: "/api/studio" });
  await app.register(googleRoutes, { prefix: "/api/studio/google" });
  await app.register(bookingRoutes, { prefix: "/api/studio" });
  // Clients reach these without signing in, so they sit outside /api/studio and its access rule.
  await app.register(publicRoutes, { prefix: "/api/public" });

  await app.register(aiRoutes, { prefix: "/api/studio/ai" });
  await app.register(automationRoutes, { prefix: "/api/studio/automation" });
  // Public path with its own bearer-token auth, so AI clients connect without a second sign-in.
  await app.register(mcpRoutes);
  await app.register(oauthRoutes);
  await app.register(oauthStudioRoutes, { prefix: "/api/studio/oauth" });

  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "not_found", message: "No such endpoint." }));

  // The web app. Hashed assets are cached forever; index.html never is.
  if (fs.existsSync(path.join(config.webDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      index: false,
      setHeaders(res, file) {
        res.header("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.get("/", async (_req, reply) => reply.redirect("/studio"));
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  } else {
    app.log.warn({ webDir: config.webDir }, "web UI not built; only the API is available");
  }

  const scheduleBackup = registerBackupJob(config.configDir, () => settings);

  if (startBackground) {
    tunnel.setToken(settings.get("tunnel.token") || config.tunnelToken);
    jobs.start();
    scheduleBackup(db);
    const hourly = setInterval(() => scheduleBackup(db), 3_600_000);
    const googleTimer = setInterval(() => requestSync(db, 0), 5 * 60_000);
    setTimeout(() => requestSync(db, 0), 10_000).unref();
    app.addHook("onClose", async () => {
      clearInterval(hourly);
      clearInterval(googleTimer);
      await jobs.stop();
      await tunnel.shutdown();
    });
  }
  app.addHook("onClose", async () => {
    db.$client.close();
  });

  return app;
}

/** Best guess at the server's LAN address, for "open it locally" hints. */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}
