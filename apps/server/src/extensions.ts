import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { requireOwner } from "./auth.js";
import { financialReport, resolveRange, type FinancialReport } from "./domain/reports.js";
import { VERSION, type AppContext } from "./app.js";
import { hashPassword, generateLoginPassword } from "./auth.js";
import { backupProviders, incomingSubfolderHooks, mailSenders, shootScopeHooks } from "./extension-hooks.js";
import { defineTool, grantCapability, lockCapability, revokeCapability } from "./ai/registry.js";
import { registerSiteExtension, registerSiteTemplate, unregisterSiteExtension, unregisterSiteTemplate, type SiteExtension, type SiteTemplate } from "./site/registry.js";

/**
 * Extensions are optional modules that add tools, routes, or capabilities to OpenPortrait. They are plain
 * ES modules in the `extensions` folder of the config directory, and each exports `register(api)`.
 * Loading code from that folder is the same trust level as the container itself: keep the folder
 * writable only by the app user. A module that fails to load is skipped and logged.
 */
/**
 * A settings card an extension can show under Settings > Extensions. The app renders it, so extensions
 * need no UI code. `status.route` is a GET under the extension's routes; its JSON fills the card. An action route may
 * answer `{ openUrl }` (an https or same-site address) to send the owner there, for connecting an outside service.
 */
export interface SettingsCard {
  title: string;
  description?: string;
  status: {
    route: string;
    /** Picks a status chip from a key of the status JSON. */
    chip?: { key: string; values: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> };
    rows?: Array<{ key: string; label: string; format?: "date" | "text" }>;
    /** A key whose string value is shown as a warning when present. */
    notice?: string;
    /** Progress bars. `data[key]` is a {@link CardMeter}, or null/absent when nothing is in progress. */
    meters?: Array<{ key: string }>;
    /** Number tiles shown above the rows. `bytes` formats as KB/MB/GB. */
    stats?: Array<{ key: string; label: string; format?: "bytes" | "number" | "text"; hintKey?: string }>;
    /** Charts. `data[key]` is a {@link CardChart}. */
    charts?: Array<{ key: string; title: string; format?: "bytes" | "number" }>;
    /** Lists drawn from arrays in the status JSON, each row optionally removable. */
    lists?: Array<{
      key: string;
      label: string;
      empty?: string;
      /** Keys of each item: its title, an optional second line, and its id. */
      title: string;
      subtitle?: string;
      id?: string;
      /** DELETE route; `{id}` is replaced with the item's id. */
      removeRoute?: string;
      removeConfirm?: string;
    }>;
  };
  actions: Array<{
    label: string;
    route: string;
    primary?: boolean;
    /** Only offered when status[key] === equals. */
    when?: { key: string; equals: string | boolean };
    /** A field with `optionsKey` is a dropdown filled from an array of { value, label } in the status JSON. */
    fields?: Array<{ name: string; label: string; hint?: string; secret?: boolean; optionsKey?: string; optional?: boolean }>;
    confirm?: string;
  }>;
}

/** Status JSON for a progress bar. While `data.refreshMs` (a number) is present, the card reloads itself that often. */
export interface CardMeter {
  label: string;
  detail?: string;
  done: number;
  total: number;
  format?: "bytes" | "number";
  tone?: "ok" | "warn" | "bad" | "neutral";
}
/** Status JSON for a chart: one or more views of the same data, such as by month and by year. */
export interface CardChart {
  views: Array<{ key: string; label: string; layout: "bars" | "columns"; points: Array<{ label: string; short?: string; value: number }>; note?: string }>;
}

/**
 * A section an extension adds to the Reports page. The page calls `route` (a GET under the extension's routes) with
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` and draws the answer, a {@link ReportData}, so extensions need no UI code.
 */
export interface ReportSection {
  title: string;
  description?: string;
  route: string;
}

export interface ReportData {
  stats?: Array<{ label: string; value: number | string; format?: "money" | "number" | "text"; tone?: "ok" | "warn" | "bad" | "neutral"; hint?: string }>;
  /** Horizontal bars, such as income by category. Money values are cents. */
  bars?: Array<{ title: string; format?: "money" | "number"; rows: Array<{ label: string; value: number }> }>;
  tables?: Array<{
    title?: string;
    columns: Array<{ key: string; label: string; format?: "money" | "number" | "text"; align?: "start" | "end" }>;
    rows: Array<Record<string, string | number | null>>;
  }>;
  /** Shown above the data, for a caveat such as "mileage uses the rate set in Settings". */
  notice?: string;
}

/** Gets the file's path inside Incoming, such as "Z9/2026-11-14/DSC_1.NEF". Returns a folder name, or nothing. */
export type IncomingSubfolderHook = (info: { shootId: string; path: string }) => string | undefined | null;
/**
 * An outside place to copy backups, such as a cloud bucket. The owner adds one or more destinations of this kind under
 * Settings > Backups; the app draws the form from `fields`, stores the values encrypted, and calls these methods.
 * Each method receives the destination's saved values and throws an Error with a plain-language message on failure.
 */
export interface BackupProvider {
  /** Stable id, for example "s3". Must not be "folder". */
  kind: string;
  /** Shown in the list of destination types, for example "Amazon S3 or Backblaze B2". */
  label: string;
  description?: string;
  fields: Array<{ name: string; label: string; hint?: string; secret?: boolean; optional?: boolean }>;
  /** Checks the values and the connection. Used by "Test" and before saving. */
  check(config: Record<string, string>): Promise<void>;
  /** Copies one backup file. Must not leave a partial file under the final name. */
  upload(config: Record<string, string>, file: { path: string; name: string; size: number }): Promise<void>;
  /** Backups already at the destination, so old ones can be removed. */
  list(config: Record<string, string>): Promise<Array<{ name: string }>>;
  remove(config: Record<string, string>, name: string): Promise<void>;
}
/** An outside way to send the studio's email, such as a hosted mailbox. */
export interface MailSender {
  /** Shown in Settings > Email, for example "Microsoft 365". */
  label: string;
  /** True when it is connected and can send right now. */
  ready(): boolean;
  send(mail: { fromName: string; to: string; toName?: string | null; replyTo?: string; subject: string; text: string; html?: string }): Promise<void>;
}
/** One column in a page's table. `money` values are whole cents, `date` values are YYYY-MM-DD. */
export interface PageColumn {
  key: string;
  label: string;
  format?: "text" | "money" | "date" | "number";
  /** Shown after a number, for example "mi". */
  unit?: string;
  /** Secondary text shown under the value, taken from another key of the row. */
  sub?: string;
}

export interface PageField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "date" | "select" | "checkbox";
  hint?: string;
  required?: boolean;
  /** Prefilled when adding. `today` fills a date field with today's date. */
  default?: string | number | boolean;
  /** For `select`: fixed choices, or a GET route that returns `{ options: [{ value, label }] }`. */
  options?: Array<{ value: string; label: string }>;
  optionsRoute?: string;
  /** Takes the whole row of the form instead of half of it. */
  wide?: boolean;
}

/**
 * A full page an extension adds to the sidebar: a list of records with totals, an add/edit form, and optional CSV
 * export. The app draws it from this description, so extensions need no UI code. Every route is a GET/POST/PATCH/DELETE
 * under the extension's routes. A route may answer 403 with `{ message, locked: true }` when the feature isn't
 * available, and the page then shows that message instead of the records.
 */
export interface ExtensionPage {
  /** The page's address: /studio/x/<extension id>/<slug>. */
  slug: string;
  title: string;
  /** An icon name from the app's icon set; unknown names fall back to a generic one. */
  icon?: string;
  /** Sidebar group heading. Pages with the same group sit together. */
  group?: string;
  description?: string;
  /** A year (or other period) picker. Its value is sent as `?<name>=` to every route of the page. */
  filter?: { name: string; label: string; optionsRoute: string };
  /** GET; returns numbers for the tiles, and optionally `notice` to show as a warning. */
  summary?: { route: string; tiles: Array<{ key: string; label: string; format?: "text" | "money" | "number"; unit?: string }> };
  /**
   * A help page instead of a list: GET returns `{ markdown, locked? }` and the app shows it as formatted text
   * (headings, paragraphs, lists, tables, bold, code, links and images). Use it for a guide that ships with the extension.
   * A page has either `guide` or `list`. Return 403 `{ message, locked: true }` to hide it.
   */
  guide?: { route: string };
  /** GET; returns `{ rows: [{ id, ... }] }`. */
  list?: { route: string; columns: PageColumn[]; empty: { title: string; text: string } };
  /** POST <create> adds a record; PATCH <item>/<id> and DELETE <item>/<id> change or remove one. Bodies are JSON. */
  form?: { title: string; addLabel: string; create: string; item: string; fields: PageField[] };
  /** GET; returns text/csv. */
  export?: { label: string; route: string };
}

/** Returns the ids of the shoots this user may see, or null when the user isn't limited. */
export type ShootScopeHook = (user: { id: string; role: string }) => string[] | null;

export interface ExtensionApi {
  /** The module's id: its file name without the extension. */
  id: string;
  appVersion: string;
  ctx: AppContext;
  log: FastifyInstance["log"];
  defineTool: typeof defineTool;
  /** The app's copy of zod, so tool inputs and request bodies are validated with the same library the app uses. */
  z: typeof z;
  /** Adds staff-only (owner) routes under /api/studio/extensions/<id>/. */
  routes(plugin: FastifyPluginAsync): void;
  /**
   * Remote storage for full-size originals. Previews stay on local disk. The extension uploads and verifies
   * copies itself, then calls `originals.markRemote`. Attach a store only while the extension is licensed to.
   */
  originals: AppContext["originals"];
  /** Hides a capability group's tools until `grantCapability` is called for it. Call it before defining the group's tools. */
  lockCapability(id: string): void;
  grantCapability(id: string): void;
  revokeCapability(id: string): void;
  /** Shows a card under Settings > Extensions (owner only). */
  settingsCard(card: SettingsCard): void;
  /** Adds a section to the Reports page (owner only). */
  reportSection(section: ReportSection): void;
  /** The studio's income figures for a date range (YYYY-MM-DD), the same ones the Reports page shows. Throws on a bad range. */
  financialReport(from: string, to: string): FinancialReport;
  /** Shows a card on every shoot's page (owner only). Routes may contain `{shootId}`. */
  shootCard(card: SettingsCard): void;
  /** Creates this extension's own tables. Each named step runs once. Tables must be named `ext_<id>_...`. */
  migrate(name: string, sql: string): void;
  /** Lets an extension pick a subfolder (inside the shoot's RAW folder) for files moved in from Incoming. */
  incomingSubfolder(fn: IncomingSubfolderHook): void;
  /** Offers an outside mailbox for sending. While it is ready, it replaces the SMTP settings for outgoing email. */
  mailSender(sender: MailSender): void;
  /** Offers another place to copy backups to. See BackupProvider. */
  backupProvider(provider: BackupProvider): void;
  /** Adds a page to the sidebar (owner only). See ExtensionPage. */
  page(page: ExtensionPage): void;
  /**
   * Limits some signed-in users to a list of shoots. A limited user can only sign in, change their password, and open
   * the shoots on their list (read-only); every other studio route answers 403. Return null for users you don't limit.
   */
  limitUsersToShoots(fn: ShootScopeHook): void;
  /** Creates a "staff" sign-in with a generated password, shown once to the owner. Rejects an email already in use. */
  createStaffLogin(input: { email: string; name: string }): Promise<{ id: string; password: string }>;
  /** Runs when the app shuts down. */
  onClose(fn: () => void | Promise<void>): void;
  /** Adds to the website builder: more templates, fields in its "More" tab, pages, CSS, and files. Can be undone when no longer allowed. */
  site: {
    registerTemplate(t: SiteTemplate): void;
    unregisterTemplate(id: string): void;
    registerExtension(e: Omit<SiteExtension, "id">): void;
    unregisterExtension(): void;
  };
}

export interface ExtensionInfo {
  id: string;
  file: string;
  sha256: string;
  status: "loaded" | "failed";
  error?: string;
  /** The add-on's own version, from its optional `version` export. */
  version?: string;
  cards: SettingsCard[];
  reports: ReportSection[];
  shootCards: SettingsCard[];
  pages: ExtensionPage[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function extensionsDir(ctx: AppContext): string {
  return process.env.OPENPORTRAIT_EXTENSIONS_DIR || path.join(ctx.config.configDir, "extensions");
}

const TABLE = /\b(?:create\s+(?:unique\s+)?(?:table|index)(?:\s+if\s+not\s+exists)?|alter\s+table|drop\s+table|insert\s+into|update|delete\s+from)\s+(?:\w+\s+on\s+)?"?(\w+)"?/gi;

/** Runs a named SQL step once. Extensions may only touch tables that start with `ext_<id>_`. */
export function runExtensionMigration(ctx: AppContext, id: string, name: string, sql: string): void {
  const prefix = `ext_${id.replace(/-/g, "_")}_`;
  for (const m of sql.matchAll(TABLE)) {
    if (!m[1]!.toLowerCase().startsWith(prefix)) throw new Error(`migration "${name}" touches "${m[1]}", but ${id} may only use tables named ${prefix}...`);
  }
  const client = ctx.db.$client;
  client.exec("CREATE TABLE IF NOT EXISTS extension_migration (extension TEXT NOT NULL, name TEXT NOT NULL, ran_at INTEGER NOT NULL, PRIMARY KEY (extension, name))");
  if (client.prepare("SELECT 1 FROM extension_migration WHERE extension = ? AND name = ?").get(id, name)) return;
  client.transaction(() => {
    client.exec(sql);
    client.prepare("INSERT INTO extension_migration (extension, name, ran_at) VALUES (?, ?, ?)").run(id, name, Date.now());
  })();
}

export async function loadExtensions(app: FastifyInstance, ctx: AppContext): Promise<ExtensionInfo[]> {
  const dir = extensionsDir(ctx);
  const infos: ExtensionInfo[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    return infos;
  }
  for (const file of files) {
    const id = file.replace(/\.mjs$/, "");
    const full = path.join(dir, file);
    const info: ExtensionInfo = { id, file, sha256: "", status: "failed", cards: [], reports: [], shootCards: [], pages: [] };
    infos.push(info);
    try {
      if (!ID.test(id)) throw new Error("file name must be lowercase letters, digits and dashes");
      info.sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      const mod = (await import(`${pathToFileURL(full).href}?h=${info.sha256}`)) as { register?: (api: ExtensionApi) => void | Promise<void>; version?: unknown };
      if (typeof mod.register !== "function") throw new Error("module has no register() export");
      if (typeof mod.version === "string" && /^[\w.+-]{1,40}$/.test(mod.version)) info.version = mod.version;
      const routes: FastifyPluginAsync[] = [];
      const cards: SettingsCard[] = [];
      const reports: ReportSection[] = [];
      const shootCards: SettingsCard[] = [];
      const pages: ExtensionPage[] = [];
      await mod.register({
        id,
        appVersion: VERSION,
        ctx,
        log: app.log,
        defineTool,
        originals: ctx.originals,
        z,
        routes: (plugin) => void routes.push(plugin),
        settingsCard: (card) => void cards.push(card),
        reportSection: (section) => void reports.push(section),
        financialReport: (from, to) => {
          const sctx = { db: ctx.db, settings: ctx.settings, config: ctx.config, actorId: null, publicUrl: ctx.publicUrl };
          return financialReport(sctx, resolveRange(sctx, from, to));
        },
        shootCard: (card) => void shootCards.push(card),
        migrate: (name, sql) => runExtensionMigration(ctx, id, name, sql),
        incomingSubfolder: (fn) => {
          incomingSubfolderHooks.push(fn);
          app.addHook("onClose", async () => void incomingSubfolderHooks.splice(incomingSubfolderHooks.indexOf(fn), 1));
        },
        limitUsersToShoots: (fn) => {
          shootScopeHooks.push(fn);
          app.addHook("onClose", async () => void shootScopeHooks.splice(shootScopeHooks.indexOf(fn), 1));
        },
        createStaffLogin: async ({ email, name }) => {
          const mail = email.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error("Enter a valid email address.");
          if (ctx.db.select({ id: tables.user.id }).from(tables.user).where(eq(tables.user.email, mail)).get()) throw new Error("Someone already signs in with that email.");
          const password = generateLoginPassword();
          const userId = crypto.randomUUID();
          ctx.db.insert(tables.user).values({ id: userId, email: mail, name: name.trim().slice(0, 80) || mail, passwordHash: await hashPassword(password), role: "staff" }).run();
          ctx.db.insert(tables.auditLog).values({ action: "auth.staff_created", detail: { userId, via: id } }).run();
          return { id: userId, password };
        },
        backupProvider: (provider) => {
          if (provider.kind === "folder") throw new Error('backup provider kind "folder" is built in');
          backupProviders.push(provider);
          app.addHook("onClose", async () => void backupProviders.splice(backupProviders.indexOf(provider), 1));
        },
        mailSender: (sender) => {
          mailSenders.push(sender);
          app.addHook("onClose", async () => void mailSenders.splice(mailSenders.indexOf(sender), 1));
        },
        page: (page) => {
          if (!SLUG.test(page.slug)) throw new Error(`page slug "${page.slug}" must be lowercase letters, digits and dashes`);
          if (!page.list && !page.guide) throw new Error(`page "${page.slug}" needs a list or a guide`);
          if (pages.some((p) => p.slug === page.slug)) throw new Error(`duplicate page slug "${page.slug}"`);
          pages.push(page);
        },
        lockCapability,
        grantCapability,
        revokeCapability,
        site: {
          registerTemplate: (t) => registerSiteTemplate({ ...t, extra: true }),
          unregisterTemplate: unregisterSiteTemplate,
          registerExtension: (e) => registerSiteExtension({ ...e, id }),
          unregisterExtension: () => unregisterSiteExtension(id),
        },
        onClose: (fn) => void app.addHook("onClose", async () => void (await fn())),
      });
      for (const plugin of routes) {
        await app.register(
          async (scope) => {
            scope.addHook("preHandler", requireOwner);
            await scope.register(plugin);
          },
          { prefix: `/api/studio/extensions/${id}` },
        );
      }
      info.cards = cards;
      info.reports = reports;
      info.shootCards = shootCards;
      info.pages = pages;
      info.status = "loaded";
      app.log.info({ extension: id, sha256: info.sha256 }, "extension loaded");
    } catch (err) {
      info.error = (err as Error).message;
      app.log.error({ extension: id, err: info.error }, "extension skipped");
    }
  }
  return infos;
}

/** Lists what is installed, for the Settings screen. */
export const extensionRoutes =
  (infos: ExtensionInfo[]): FastifyPluginAsync =>
  async (app) => {
    app.get("/", { preHandler: requireOwner }, async () => ({ extensions: infos }));
  };
