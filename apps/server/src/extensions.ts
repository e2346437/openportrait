import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireOwner } from "./auth.js";
import { VERSION, type AppContext } from "./app.js";
import { defineTool, grantCapability, lockCapability, revokeCapability } from "./ai/registry.js";

/**
 * Extensions are optional modules that add tools, routes, or capabilities to OpenPortrait. They are plain
 * ES modules in the `extensions` folder of the config directory, and each exports `register(api)`.
 * Loading code from that folder is the same trust level as the container itself: keep the folder
 * writable only by the app user. A module that fails to load is skipped and logged.
 */
/**
 * A settings card an extension can show under Settings > Extensions. The app renders it, so extensions
 * need no UI code. `status.route` is a GET under the extension's routes; its JSON fills the card.
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
  };
  actions: Array<{
    label: string;
    route: string;
    primary?: boolean;
    /** Only offered when status[key] === equals. */
    when?: { key: string; equals: string | boolean };
    fields?: Array<{ name: string; label: string; hint?: string; secret?: boolean }>;
    confirm?: string;
  }>;
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
  /** GET; returns `{ rows: [{ id, ... }] }`. */
  list: { route: string; columns: PageColumn[]; empty: { title: string; text: string } };
  /** POST <create> adds a record; PATCH <item>/<id> and DELETE <item>/<id> change or remove one. Bodies are JSON. */
  form?: { title: string; addLabel: string; create: string; item: string; fields: PageField[] };
  /** GET; returns text/csv. */
  export?: { label: string; route: string };
}

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
  /** Hides a capability group's tools until `grantCapability` is called for it. Call it before defining the group's tools. */
  lockCapability(id: string): void;
  grantCapability(id: string): void;
  revokeCapability(id: string): void;
  /** Shows a card under Settings > Extensions (owner only). */
  settingsCard(card: SettingsCard): void;
  /** Adds a page to the sidebar (owner only). See ExtensionPage. */
  page(page: ExtensionPage): void;
  /** Runs when the app shuts down. */
  onClose(fn: () => void | Promise<void>): void;
}

export interface ExtensionInfo {
  id: string;
  file: string;
  sha256: string;
  status: "loaded" | "failed";
  error?: string;
  cards: SettingsCard[];
  pages: ExtensionPage[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function extensionsDir(ctx: AppContext): string {
  return process.env.OPENPORTRAIT_EXTENSIONS_DIR || path.join(ctx.config.configDir, "extensions");
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
    const info: ExtensionInfo = { id, file, sha256: "", status: "failed", cards: [], pages: [] };
    infos.push(info);
    try {
      if (!ID.test(id)) throw new Error("file name must be lowercase letters, digits and dashes");
      info.sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      const mod = (await import(`${pathToFileURL(full).href}?h=${info.sha256}`)) as { register?: (api: ExtensionApi) => void | Promise<void> };
      if (typeof mod.register !== "function") throw new Error("module has no register() export");
      const routes: FastifyPluginAsync[] = [];
      const cards: SettingsCard[] = [];
      const pages: ExtensionPage[] = [];
      await mod.register({
        id,
        appVersion: VERSION,
        ctx,
        log: app.log,
        defineTool,
        z,
        routes: (plugin) => void routes.push(plugin),
        settingsCard: (card) => void cards.push(card),
        page: (page) => {
          if (!SLUG.test(page.slug)) throw new Error(`page slug "${page.slug}" must be lowercase letters, digits and dashes`);
          if (pages.some((p) => p.slug === page.slug)) throw new Error(`duplicate page slug "${page.slug}"`);
          pages.push(page);
        },
        lockCapability,
        grantCapability,
        revokeCapability,
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
