import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { tables } from "@openportrait/db";
import type { AppContext } from "../app.js";
import { cleanConfig, defaultSite, usedPhotoIds } from "./config.js";
import { prepareImage, prepareShareImage, type PreparedImage } from "./images.js";
import { renderSite, type RenderResult } from "./render.js";
import type { PhotoSource, SiteConfig } from "./types.js";

const ROW = "main";

export function loadSite(ctx: AppContext): SiteConfig {
  const row = ctx.db.select().from(tables.site).where(eq(tables.site.id, ROW)).get();
  const studio = ctx.settings.get("studio.name") ?? "";
  return row ? cleanConfig(row.config, studio) : defaultSite(studio);
}

export function saveSite(ctx: AppContext, config: SiteConfig): void {
  const now = new Date();
  ctx.db
    .insert(tables.site)
    .values({ id: ROW, config: config as unknown as Record<string, unknown>, updatedAt: now })
    .onConflictDoUpdate({ target: tables.site.id, set: { config: config as unknown as Record<string, unknown>, updatedAt: now } })
    .run();
}

export function markExported(ctx: AppContext): void {
  ctx.db.update(tables.site).set({ lastExportedAt: new Date() }).where(eq(tables.site.id, ROW)).run();
}

/** The photos the site names, read from the library. Anything the owner did not pick is never loaded. */
export function loadSources(ctx: AppContext, ids: string[]): PhotoSource[] {
  if (!ids.length) return [];
  return ctx.db
    .select({ id: tables.photo.id, relPath: tables.photo.relPath, contentHash: tables.photo.contentHash, width: tables.photo.width, height: tables.photo.height, state: tables.photo.state })
    .from(tables.photo)
    .where(inArray(tables.photo.id, ids))
    .all()
    .filter((p) => p.state === "ready" || p.state === "pending");
}

/** Builds the whole site in memory (images are cached on disk). Used by both the preview and the export. */
export async function buildSite(ctx: AppContext): Promise<RenderResult & { config: SiteConfig; photoCount: number }> {
  const config = loadSite(ctx);
  const ids = usedPhotoIds(config);
  const sources = loadSources(ctx, ids);
  const images = new Map<string, PreparedImage>();
  for (const src of sources) {
    try {
      const prepared = await prepareImage(src, ctx.config.galleriesDir, ctx.config.cacheDir);
      if (prepared) images.set(src.id, prepared);
    } catch {
      // A photo that can't be read is counted and reported below.
    }
  }
  const sharePhoto = sources.find((s) => s.id === config.seo.sharePhotoId);
  const share = sharePhoto ? await prepareShareImage(sharePhoto, ctx.config.galleriesDir, ctx.config.cacheDir).catch(() => null) : null;

  let logo: { png: Buffer; icon: Buffer } | null = null;
  const logoFile = path.join(ctx.config.configDir, "logo.png");
  if (config.useLogo && fs.existsSync(logoFile)) {
    const png = fs.readFileSync(logoFile);
    logo = { png, icon: await sharp(png).resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer() };
  }
  const publicUrl = ctx.settings.get("internet.publicUrl") || ctx.publicUrl();
  const inquireOn = ctx.settings.get("inquiry.enabled") !== false;
  const result = renderSite({ config, inquireUrl: publicUrl && inquireOn ? `${publicUrl.replace(/\/+$/, "")}/inquire` : "", logo, images, share });
  const missing = ids.filter((id) => !images.has(id)).length;
  if (missing) result.warnings.push(`${missing} picked photo${missing > 1 ? "s" : ""} could not be read from the photo library and ${missing > 1 ? "were" : "was"} left out.`);
  return { ...result, config, photoCount: images.size };
}
