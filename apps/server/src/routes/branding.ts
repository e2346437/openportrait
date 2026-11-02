import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { requireOwner, requireUser } from "../auth.js";

const MAX_BYTES = 5 * 1024 * 1024;

/** The studio logo: shown at the top of client galleries. Stored once, trimmed of empty margins and normalized to a PNG that fits 600 x 300 px. */
export async function brandingRoutes(app: FastifyInstance) {
  const { settings, config } = app.ctx;
  const file = path.join(config.configDir, "logo.png");

  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get("/api/branding/logo", async (_req, reply) => {
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(file));
  });

  app.get("/api/studio/branding", { preHandler: requireUser }, async () => {
    const v = settings.get("studio.logoVersion");
    return { logo: v ? `/api/branding/logo?v=${v}` : null };
  });

  app.put("/api/studio/branding/logo", { preHandler: requireOwner }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "invalid", message: "Upload a PNG, JPEG or WebP image." });
    try {
      let img = sharp(req.body).rotate();
      // Trim empty edges (transparent or a flat background) so the logo fills its box; keep the original if nothing is left.
      try {
        const trimmed = await img.clone().trim({ threshold: 10 }).toBuffer();
        img = sharp(trimmed);
      } catch {
        img = sharp(req.body).rotate();
      }
      const png = await img.resize({ width: 600, height: 300, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      fs.mkdirSync(config.configDir, { recursive: true });
      fs.writeFileSync(file, png);
    } catch {
      return reply.code(400).send({ error: "invalid", message: "That file couldn't be read as an image." });
    }
    const version = Date.now();
    settings.set("studio.logoVersion", version);
    return { logo: `/api/branding/logo?v=${version}` };
  });

  app.delete("/api/studio/branding/logo", { preHandler: requireOwner }, async () => {
    fs.rmSync(file, { force: true });
    settings.set("studio.logoVersion", 0);
    return { logo: null };
  });
}
