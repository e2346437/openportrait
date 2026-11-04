import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "@openportrait/config";
import { openDatabase, type Db } from "@openportrait/db";
import { JobRunner } from "@openportrait/jobs";
import { SESSION_COOKIE, lookupSession } from "./auth.js";
import { BackupService, registerBackupJob } from "./backup.js";
import { backupRoutes } from "./routes/backups.js";
import { applyPendingRestore, RestoreService } from "./restore.js";
import { logRoutes } from "./routes/logs.js";
import { createLogStream } from "./logs.js";
import { clientIp } from "./client-ip.js";
import { crossSiteBlocked, rejectCrossSite } from "./csrf.js";
import { Secrets } from "./secrets.js";
import { Settings } from "./settings.js";
import { TunnelManager } from "./tunnel.js";
import { registerDerivativesJob } from "./galleries/derivatives.js";
import { GalleryIngest } from "./galleries/ingest.js";
import { startGalleryWatcher } from "./galleries/watcher.js";
import { clientGalleryRoutes, mediaRoutes } from "./routes/client-gallery.js";
import { galleryRoutes, ingestRoutes } from "./routes/galleries.js";
import { watermarkRoutes } from "./routes/watermark.js";
import { siteRoutes } from "./routes/site.js";
import { registerFreeTemplates } from "./site/templates.js";
import { mcpRoutes } from "./ai/mcp.js";
import { Originals } from "./galleries/originals.js";
import { enforceShootScope, shootScopeFor } from "./scope.js";
import { loadExtensions, extensionRoutes } from "./extensions.js";
import { oauthRoutes, oauthStudioRoutes } from "./ai/oauth.js";
import { aiRoutes } from "./routes/ai.js";
import { automationRoutes } from "./routes/automation.js";
import { ensureDefaults } from "./domain/defaults.js";
import { DomainError } from "./domain/context.js";
import { authRoutes } from "./routes/auth.js";
import { brandingRoutes } from "./routes/branding.js";
import { uploadRoutes as photoUploadRoutes } from "./routes/uploads.js";
import { catalogRoutes } from "./routes/catalog.js";
import { calendarRoutes } from "./routes/calendar.js";
import { googleRoutes } from "./routes/google.js";
import { bookingRoutes } from "./routes/booking.js";
import { orderRoutes } from "./routes/orders.js";
import { reportRoutes } from "./routes/reports.js";
import { contractRoutes } from "./routes/contracts.js";
import { householdRoutes } from "./routes/households.js";
import { taskRoutes } from "./routes/tasks.js";
import { runSheetRoutes } from "./routes/runsheet.js";
import { publicRoutes } from "./routes/public.js";
import { questionnaireRoutes } from "./routes/questionnaires.js";
import { registerEmailJob } from "./domain/email.js";
import { homeRoutes } from "./routes/home.js";
import { registerGoogleSyncJob } from "./google/job.js";
import { crmRoutes } from "./routes/crm.js";
import { importRoutes } from "./routes/import.js";
import { exportRoutes } from "./routes/export.js";
import { internetRoutes } from "./routes/internet.js";
import { settingsRoutes } from "./routes/settings.js";
import { setupRoutes } from "./routes/setup.js";
import { tetherRoutes } from "./routes/tether.js";
import { incomingRoutes } from "./routes/incoming.js";
import { uploadRoutes } from "./routes/upload.js";
import { UploadManager } from "./upload/manager.js";
import { lanHosts, lanInfo, type LanInfo } from "./lan.js";

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const SEMVER = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const tagged = SEMVER.exec(process.env.OPENPORTRAIT_VERSION ?? "");
/** The release version: the image's semver tag when it has one, otherwise the package version. */
export const VERSION = tagged ? tagged[1]! : PACKAGE_VERSION;

/** What is running, for the About panel and the sidebar. The image build stamps the commit and time; a dev run has neither. */
export const BUILD = {
  version: VERSION,
  /** Short git commit, or null outside the published image. */
  commit: /^[0-9a-f]{7,40}$/i.test(process.env.OPENPORTRAIT_COMMIT ?? "") ? process.env.OPENPORTRAIT_COMMIT!.slice(0, 7).toLowerCase() : null,
  /** ISO time the image was built, or null. */
  builtAt: process.env.OPENPORTRAIT_BUILT && !Number.isNaN(Date.parse(process.env.OPENPORTRAIT_BUILT)) ? new Date(process.env.OPENPORTRAIT_BUILT).toISOString() : null,
  /** "release" for a version tag, the tag name (edge, latest) for a rolling image, "dev" when run from source. */
  channel: tagged ? "release" : process.env.OPENPORTRAIT_VERSION && process.env.OPENPORTRAIT_VERSION !== "dev" ? process.env.OPENPORTRAIT_VERSION : "dev",
};

export interface AppContext {
  config: AppConfig;
  db: Db;
  secrets: Secrets;
  settings: Settings;
  tunnel: TunnelManager;
  uploads: UploadManager;
  jobs: JobRunner;
  galleries: GalleryIngest;
  /** Where full-size originals are read from; extensions can attach remote storage (see galleries/originals.ts). */
  originals: Originals;
  backups: BackupService;
  restore: RestoreService;
  /** Public base URL: setting, then APP_URL, then the tunnel's first hostname. */
  publicUrl(): string;
  /** This server's address on the home network (see lan.ts). */
  lan(): LanInfo;
  ip(req: import("fastify").FastifyRequest): string;
  /** Absolute address for links and metadata: the configured public address, else the home-network one, else localhost. Never taken from the request. */
  baseUrl(): string;
  /** Hosts this studio is legitimately reached on (public, configured, home network). */
  ownHosts(): string[];
  /** Code required by the first-run wizard. null = not required. undefined = generate one at first start. */
  setupCode?: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

/**
 * Content-Security-Policy for the whole app (SEC-009). The pages load only their own scripts, styles, fonts and
 * images; inline styles are allowed because the UI sets some. PayPal checkout is a redirect, so no PayPal script
 * runs here. Nothing may frame the app except itself, and forms can only post back to it.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export interface BuildOptions {
  config: AppConfig;
  /** Tests pass false to skip timers and child processes. */
  startBackground?: boolean;
  logger?: boolean | object;
  /**
   * First-run setup code. Leave undefined to require one (SETUP_CODE, or a random code printed to the log).
   * Pass null only to skip the check, which tests and embedding code do.
   */
  setupCode?: string | null;
}

export async function buildApp({ config, startBackground = true, logger, setupCode }: BuildOptions): Promise<FastifyInstance> {
  for (const dir of [config.configDir, config.cacheDir]) fs.mkdirSync(dir, { recursive: true });

  const app = Fastify({
    // The log goes to standard output and to a size-capped file the owner can read in Settings.
    logger: logger ?? { level: config.logLevel, stream: createLogStream(path.join(config.configDir, "logs")) },
    bodyLimit: 1024 * 1024,
  });

  // A restore the owner confirmed is applied here, before the database opens.
  const photosPending = applyPendingRestore(config.configDir);
  const db = openDatabase({ file: path.join(config.configDir, "openportrait.db") });
  ensureDefaults(db);
  const secrets = Secrets.load(config.configDir);
  const settings = new Settings(db, secrets);
  const tunnel = new TunnelManager(app.log);
  const jobs = new JobRunner(db, { logger: app.log });
  const galleries = new GalleryIngest({ db, settings, galleriesDir: config.galleriesDir, settleSeconds: config.ingestSettleSeconds, logger: app.log });
  const originals = new Originals({ db, galleriesDir: config.galleriesDir });
  galleries.setOriginals(originals);
  registerDerivativesJob(config);
  const uploads = new UploadManager({ config, db, settings, log: app.log, lanHosts: () => lanHosts(settings, config) });

  const backups = new BackupService({ db, settings, configDir: config.configDir, galleriesDir: config.galleriesDir });
  const ctx: AppContext = {
    config,
    db,
    secrets,
    settings,
    tunnel,
    uploads,
    jobs,
    galleries,
    originals,
    backups,
    restore: new RestoreService({ configDir: config.configDir, galleriesDir: config.galleriesDir, backups, log: app.log }),
    lan() {
      return lanInfo(settings, config);
    },
    publicUrl() {
      const host = tunnel.getStatus().hostnames[0];
      return settings.get("internet.publicUrl") || config.appUrl || (host ? `https://${host}` : "");
    },
    baseUrl() {
      return ctx.publicUrl() || ctx.lan().url || `http://localhost:${config.port}`;
    },
    ownHosts() {
      return [ctx.publicUrl(), config.appUrl, ctx.lan().url].flatMap((u) => {
        try {
          return u ? [new URL(u).host] : [];
        } catch {
          return [];
        }
      });
    },
    ip(req) {
      return clientIp(req, settings.get("internet.trustCloudflare") ?? true);
    },
  };
  ctx.setupCode = setupCode === undefined ? (process.env.SETUP_CODE?.trim() || null) ?? undefined : setupCode;
  app.decorate("ctx", ctx);

  registerEmailJob(() => settings);
  const requestSync = registerGoogleSyncJob({ config: () => config, settings: () => settings });

  // A change to a shoot or the calendar reaches Google within seconds. The timer below is the backstop.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || reply.statusCode >= 300) return;
    if (/^\/api\/studio\/(shoots|calendar|leads)/.test(req.url)) requestSync(db);
  });

  await app.register(cookie);
  // Every rate limit keys on the verified client address, never on a header the caller can choose (SEC-001).
  await app.register(rateLimit, { global: false, keyGenerator: (req) => ctx.ip(req) });

  // Refuse state-changing studio requests that a browser says came from another site (SEC-003).
  app.addHook("onRequest", async (req, reply) => {
    const hosts = ctx.ownHosts();
    if (crossSiteBlocked(req, hosts)) return rejectCrossSite(reply);
  });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? lookupSession(db, token) : null;
    req.shootScope = shootScopeFor(req.user);
  });
  app.decorateRequest("shootScope", null);
  app.addHook("onRequest", enforceShootScope);

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    // HSTS only over HTTPS (a plain-HTTP response can't set it) and never for subdomains: the studio often shares its
    // parent domain with other sites.
    if (req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" || typeof req.headers["cf-ray"] === "string") reply.header("Strict-Transport-Security", "max-age=15552000");
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
  await app.register(galleryRoutes, { prefix: "/api/studio/galleries" });
  await app.register(ingestRoutes, { prefix: "/api/studio/ingest" });
  await app.register(watermarkRoutes, { prefix: "/api/studio/watermark" });
  registerFreeTemplates();
  await app.register(siteRoutes, { prefix: "/api/studio/site" });
  // Client pages and their media are public; the private link (and signed media URLs) are the key.
  await app.register(clientGalleryRoutes, { prefix: "/api/g" });
  await app.register(mediaRoutes);
  await app.register(brandingRoutes);
  await app.register(photoUploadRoutes, { prefix: "/api/studio/uploads" });
  await app.register(catalogRoutes, { prefix: "/api/studio" });
  await app.register(crmRoutes, { prefix: "/api/studio" });
  await app.register(importRoutes, { prefix: "/api/studio/import" });
  await app.register(exportRoutes, { prefix: "/api/studio/export" });
  await app.register(backupRoutes, { prefix: "/api/studio/backups" });
  await app.register(logRoutes, { prefix: "/api/studio/logs" });
  await app.register(tetherRoutes, { prefix: "/api/studio/tether" });
  await app.register(incomingRoutes, { prefix: "/api/studio/incoming" });
  await app.register(uploadRoutes, { prefix: "/api/studio/upload" });
  await app.register(calendarRoutes, { prefix: "/api/studio" });
  await app.register(googleRoutes, { prefix: "/api/studio/google" });
  await app.register(bookingRoutes, { prefix: "/api/studio" });
  await app.register(orderRoutes, { prefix: "/api/studio" });
  await app.register(reportRoutes, { prefix: "/api/studio" });
  await app.register(homeRoutes, { prefix: "/api/studio" });
  await app.register(contractRoutes, { prefix: "/api/studio" });
  await app.register(householdRoutes, { prefix: "/api/studio" });
  await app.register(taskRoutes, { prefix: "/api/studio" });
  await app.register(runSheetRoutes, { prefix: "/api/studio" });
  await app.register(questionnaireRoutes, { prefix: "/api/studio" });
  // Clients reach these without signing in, so they sit outside /api/studio and its access rule.
  await app.register(publicRoutes, { prefix: "/api/public" });

  await app.register(aiRoutes, { prefix: "/api/studio/ai" });
  await app.register(automationRoutes, { prefix: "/api/studio/automation" });
  // Public path with its own bearer-token auth, so AI clients connect without a second sign-in.
  await app.register(mcpRoutes);
  await app.register(oauthRoutes);
  await app.register(oauthStudioRoutes, { prefix: "/api/studio/oauth" });

  // Optional extension modules from /config/extensions. A broken one is skipped; core always boots.
  const extensions = await loadExtensions(app, ctx);
  await app.register(extensionRoutes(extensions), { prefix: "/api/studio/extensions" });

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

  const scheduleBackup = registerBackupJob(ctx.backups, () => settings);
  // Photos from a confirmed restore are copied back in the background so start-up stays quick.
  if (photosPending) ctx.restore.resume();

  if (startBackground) {
    tunnel.setToken(settings.get("tunnel.token") || config.tunnelToken);
    jobs.start();
    uploads.start();
    scheduleBackup(db);
    const hourly = setInterval(() => scheduleBackup(db), 3_600_000);
    fs.mkdirSync(config.galleriesDir, { recursive: true });
    const stopWatcher = startGalleryWatcher({ dir: config.galleriesDir, ingest: galleries, rescanMinutes: config.watchRescanMinutes, settleSeconds: config.ingestSettleSeconds, logger: app.log });
    const googleTimer = setInterval(() => requestSync(db, 0), 5 * 60_000);
    setTimeout(() => requestSync(db, 0), 10_000).unref();
    app.addHook("onClose", async () => {
      clearInterval(hourly);
      clearInterval(googleTimer);
      await stopWatcher();
      await uploads.stop();
      await jobs.stop();
      await tunnel.shutdown();
    });
  }
  app.addHook("onClose", async () => {
    galleries.close();
    db.$client.close();
  });

  return app;
}

export { lanAddresses } from "./lan.js";
