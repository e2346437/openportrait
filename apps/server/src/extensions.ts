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
  /** Runs when the app shuts down. */
  onClose(fn: () => void | Promise<void>): void;
}

export interface ExtensionInfo {
  id: string;
  file: string;
  sha256: string;
  status: "loaded" | "failed";
  error?: string;
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
    const info: ExtensionInfo = { id, file, sha256: "", status: "failed" };
    infos.push(info);
    try {
      if (!ID.test(id)) throw new Error("file name must be lowercase letters, digits and dashes");
      info.sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      const mod = (await import(`${pathToFileURL(full).href}?h=${info.sha256}`)) as { register?: (api: ExtensionApi) => void | Promise<void> };
      if (typeof mod.register !== "function") throw new Error("module has no register() export");
      const routes: FastifyPluginAsync[] = [];
      await mod.register({
        id,
        appVersion: VERSION,
        ctx,
        log: app.log,
        defineTool,
        routes: (plugin) => void routes.push(plugin),
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
