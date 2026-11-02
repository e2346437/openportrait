import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { requireOwner } from "./auth.js";
import { VERSION, type AppContext } from "./app.js";
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
  /** Adds a section to the Reports page (owner only). */
  reportSection(section: ReportSection): void;
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
  reports: ReportSection[];
}

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
    const info: ExtensionInfo = { id, file, sha256: "", status: "failed", cards: [], reports: [] };
    infos.push(info);
    try {
      if (!ID.test(id)) throw new Error("file name must be lowercase letters, digits and dashes");
      info.sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      const mod = (await import(`${pathToFileURL(full).href}?h=${info.sha256}`)) as { register?: (api: ExtensionApi) => void | Promise<void> };
      if (typeof mod.register !== "function") throw new Error("module has no register() export");
      const routes: FastifyPluginAsync[] = [];
      const cards: SettingsCard[] = [];
      const reports: ReportSection[] = [];
      await mod.register({
        id,
        appVersion: VERSION,
        ctx,
        log: app.log,
        defineTool,
        routes: (plugin) => void routes.push(plugin),
        settingsCard: (card) => void cards.push(card),
        reportSection: (section) => void reports.push(section),
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
      info.reports = reports;
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
