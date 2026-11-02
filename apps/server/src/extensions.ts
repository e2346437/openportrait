import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { requireOwner } from "./auth.js";
import { VERSION, type AppContext } from "./app.js";
import { incomingSubfolderHooks } from "./extension-hooks.js";
import { defineTool, grantCapability, revokeCapability } from "./ai/registry.js";

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

/** Gets the file's path inside Incoming, such as "Z9/2026-11-14/DSC_1.NEF". Returns a folder name, or nothing. */
export type IncomingSubfolderHook = (info: { shootId: string; path: string }) => string | undefined | null;

export interface ExtensionApi {
  /** The module's id: its file name without the extension. */
  id: string;
  appVersion: string;
  ctx: AppContext;
  log: FastifyInstance["log"];
  defineTool: typeof defineTool;
  /** Adds staff-only (owner) routes under /api/studio/extensions/<id>/. */
  routes(plugin: FastifyPluginAsync): void;
  grantCapability(id: string): void;
  revokeCapability(id: string): void;
  /** Shows a card under Settings > Extensions (owner only). */
  settingsCard(card: SettingsCard): void;
  /** Shows a card on every shoot's page (owner only). Routes may contain `{shootId}`. */
  shootCard(card: SettingsCard): void;
  /** Creates this extension's own tables. Each named step runs once. Tables must be named `ext_<id>_...`. */
  migrate(name: string, sql: string): void;
  /** Lets an extension pick a subfolder (inside the shoot's RAW folder) for files moved in from Incoming. */
  incomingSubfolder(fn: IncomingSubfolderHook): void;
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
  shootCards: SettingsCard[];
}

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
    const info: ExtensionInfo = { id, file, sha256: "", status: "failed", cards: [], shootCards: [] };
    infos.push(info);
    try {
      if (!ID.test(id)) throw new Error("file name must be lowercase letters, digits and dashes");
      info.sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      const mod = (await import(`${pathToFileURL(full).href}?h=${info.sha256}`)) as { register?: (api: ExtensionApi) => void | Promise<void> };
      if (typeof mod.register !== "function") throw new Error("module has no register() export");
      const routes: FastifyPluginAsync[] = [];
      const cards: SettingsCard[] = [];
      const shootCards: SettingsCard[] = [];
      await mod.register({
        id,
        appVersion: VERSION,
        ctx,
        log: app.log,
        defineTool,
        routes: (plugin) => void routes.push(plugin),
        settingsCard: (card) => void cards.push(card),
        shootCard: (card) => void shootCards.push(card),
        migrate: (name, sql) => runExtensionMigration(ctx, id, name, sql),
        incomingSubfolder: (fn) => {
          incomingSubfolderHooks.push(fn);
          app.addHook("onClose", async () => void incomingSubfolderHooks.splice(incomingSubfolderHooks.indexOf(fn), 1));
        },
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
      info.shootCards = shootCards;
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
