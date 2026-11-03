import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import { watermarkInput } from "../galleries/present.js";
import { renderWatermarkedBuffer, sampleBase, WATERMARK_FONTS, WatermarkSpec } from "../galleries/watermark.js";
import { parse } from "../validate.js";

const MAX_BYTES = 5 * 1024 * 1024;

const Body = z.object({ spec: WatermarkSpec, text: z.string().trim().max(60).default("") });

/** The same fields as the spec, from a query string, so Settings can preview unsaved changes with the real renderer. */
const PreviewQuery = z.object({
  mode: WatermarkSpec.shape.mode,
  font: WatermarkSpec.shape.font,
  style: WatermarkSpec.shape.style,
  color: WatermarkSpec.shape.color,
  textSize: z.coerce.number().int().min(20).max(200),
  size: z.coerce.number().int().min(8).max(80),
  opacity: z.coerce.number().int().min(10).max(100),
  position: WatermarkSpec.shape.position,
  text: z.string().trim().max(60).default(""),
});

/**
 * What lays over previews of photos still locked until payment: the studio's wording, its logo, or a custom image,
 * with a look the studio chooses. Everything is scaled to each preview, so one setting suits every size.
 */
export async function watermarkRoutes(app: FastifyInstance) {
  const { settings, config } = app.ctx;
  const imageFile = path.join(config.configDir, "watermark.png");
  app.addHook("preHandler", requireUser);
  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  const state = () => {
    const w = watermarkInput(settings, config.configDir);
    const v = settings.get("galleries.watermarkImageVersion") ?? 0;
    return {
      spec: w.spec,
      text: settings.get("galleries.watermarkText") ?? "",
      hasLogo: !!w.logoFile,
      image: w.imageFile ? `/api/studio/watermark/image?v=${v}` : null,
      fonts: Object.entries(WATERMARK_FONTS).map(([id, f]) => ({ id, label: f.label })),
    };
  };

  app.get("/", async () => state());

  app.put("/", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(Body, req.body, reply);
    if (!body) return;
    settings.set("galleries.watermark", body.spec);
    settings.set("galleries.watermarkText", body.text);
    return state();
  });

  /** A sample photo with the mark on it, drawn by the same code that marks real previews. */
  app.get("/preview", async (req, reply) => {
    const q = parse(PreviewQuery, req.query, reply);
    if (!q) return;
    const { text, ...spec } = q;
    const input = watermarkInput(settings, config.configDir);
    const out = await renderWatermarkedBuffer(await sampleBase(), { ...input, spec, text: (text || settings.get("studio.name") || "Preview").slice(0, 60) });
    reply.header("Content-Type", "image/webp");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(out);
  });

  app.get("/image", async (_req, reply) => {
    if (!fs.existsSync(imageFile)) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(imageFile));
  });

  /** Stored once, trimmed of empty edges and capped at 1200 px wide; the renderer scales it down for each preview. */
  app.put("/image", { preHandler: requireOwner }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "invalid", message: "Upload a PNG, JPEG or WebP image." });
    try {
      let img = sharp(req.body).rotate();
      try {
        img = sharp(await img.clone().trim({ threshold: 10 }).toBuffer());
      } catch {
        img = sharp(req.body).rotate();
      }
      const png = await img.resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).ensureAlpha().png().toBuffer();
      fs.mkdirSync(config.configDir, { recursive: true });
      fs.writeFileSync(imageFile, png);
    } catch {
      return reply.code(400).send({ error: "invalid", message: "That file couldn't be read as an image." });
    }
    settings.set("galleries.watermarkImageVersion", Date.now());
    return state();
  });

  app.delete("/image", { preHandler: requireOwner }, async () => {
    fs.rmSync(imageFile, { force: true });
    settings.set("galleries.watermarkImageVersion", 0);
    return state();
  });
}
