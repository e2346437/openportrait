import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { requireOwner, requireUser } from "../auth.js";
import { derivativePath } from "../galleries/derivatives.js";
import { watermarkInput } from "../galleries/present.js";
import { DEFAULT_PROOFING, EDGE_LIMITS, layoutSeed, PRESETS, PROOF_MODES, ProofingOverride, ProofingPolicy, renderProtectedBuffer, resolveProofing } from "../galleries/proofing.js";
import { sampleBase } from "../galleries/watermark.js";
import { parse } from "../validate.js";

const { photo, gallery } = tables;

const PreviewQuery = z.object({
  mode: z.enum(PROOF_MODES).default("balanced"),
  maxLongEdge: z.coerce.number().int().min(EDGE_LIMITS.min).max(EDGE_LIMITS.max).optional(),
  /** A real photo of a gallery to try the look on; staff only. Without it a neutral sample is drawn. */
  photoId: z.string().max(40).optional(),
  /** "1" returns the clean base instead of the protected copy, for the before/after view. */
  clean: z.enum(["0", "1"]).default("0"),
});

/**
 * Studio-wide Protected Proofing default (Settings > Galleries) and the live preview. A gallery can override the
 * default from its own settings (PATCH /api/studio/galleries/:id with `proofing`).
 */
export async function proofingRoutes(app: FastifyInstance) {
  const { db, settings, config, secrets } = app.ctx;
  app.addHook("preHandler", requireUser);

  const state = () => ({
    policy: resolveProofing(settings.get("galleries.proofing"), null),
    presets: PROOF_MODES.map((id) => ({ id, label: PRESETS[id].label, longEdge: PRESETS[id].longEdge })),
    limits: EDGE_LIMITS,
  });

  app.get("/", async () => state());

  app.put("/", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(ProofingOverride, req.body, reply);
    if (!body) return;
    settings.set("galleries.proofing", ProofingOverride.parse({ ...DEFAULT_PROOFING, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) }));
    return state();
  });

  app.get("/preview", async (req, reply) => {
    const q = parse(PreviewQuery, req.query, reply);
    if (!q) return;
    let base: Buffer | string;
    let seed = "sample";
    if (q.photoId) {
      const p = db.select().from(photo).where(eq(photo.id, q.photoId)).get();
      const g = p && db.select({ id: gallery.id }).from(gallery).where(eq(gallery.id, p.galleryId)).get();
      const file = p && g ? derivativePath(config.cacheDir, p.galleryId, p.id, p.version, "preview") : null;
      if (!p || !file || !fs.existsSync(file)) return reply.code(404).send({ error: "not_found", message: "That photo has no preview yet." });
      base = file;
      seed = layoutSeed((purpose, data) => secrets.sign(purpose, data), p.galleryId, p.id);
    } else {
      base = await sampleBase();
    }
    reply.header("Content-Type", "image/webp");
    reply.header("Cache-Control", "private, no-store");
    if (q.clean === "1") {
      const sharp = (await import("sharp")).default;
      return reply.send(await sharp(base).webp({ quality: 82 }).toBuffer());
    }
    const policy = ProofingPolicy.parse({ mode: q.mode, maxLongEdge: q.maxLongEdge ?? null });
    return reply.send(await renderProtectedBuffer(base, watermarkInput(settings, config.configDir), policy, seed, "preview"));
  });
}
