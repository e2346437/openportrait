import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { requireOwner, requireUser } from "../auth.js";

const MAX_BYTES = 5 * 1024 * 1024;

/** A public image, cached hard because its URL carries a version. */
function serve(file: string, type: string) {
  return async (_req: unknown, reply: import("fastify").FastifyReply) => {
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", type);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(file));
  };
}

/** The sign-in photo's URL, or null. Shown before anyone signs in, so it is public like the logo. */
export const signInPhotoUrl = (settings: { get(key: "studio.signInPhotoVersion"): number | undefined }) => {
  const v = settings.get("studio.signInPhotoVersion");
  return v ? `/api/branding/sign-in?v=${v}` : null;
};

/**
 * The studio logo (shown at the top of client galleries; trimmed and normalized to a PNG that fits 600 x 300 px)
 * and the sign-in photo (one of the studio's own pictures behind the sign-in page; resized to 1800 px and stripped
 * of metadata so nothing about the camera or location leaks).
 */
export async function brandingRoutes(app: FastifyInstance) {
  const { settings, config } = app.ctx;
  const file = path.join(config.configDir, "logo.png");
  const signIn = path.join(config.configDir, "sign-in.jpg");

  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get("/api/branding/logo", serve(file, "image/png"));
  app.get("/api/branding/sign-in", serve(signIn, "image/jpeg"));

  const view = () => {
    const v = settings.get("studio.logoVersion");
    return { logo: v ? `/api/branding/logo?v=${v}` : null, signInPhoto: signInPhotoUrl(settings) };
  };

  app.get("/api/studio/branding", { preHandler: requireUser }, async () => view());

  app.put("/api/studio/branding/sign-in", { preHandler: requireOwner }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "invalid", message: "Upload a PNG, JPEG or WebP image." });
    try {
      const jpg = await sharp(req.body).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      fs.mkdirSync(config.configDir, { recursive: true });
      fs.writeFileSync(signIn, jpg);
    } catch {
      return reply.code(400).send({ error: "invalid", message: "That file couldn't be read as an image." });
    }
    settings.set("studio.signInPhotoVersion", Date.now());
    return view();
  });

  app.delete("/api/studio/branding/sign-in", { preHandler: requireOwner }, async () => {
    fs.rmSync(signIn, { force: true });
    settings.set("studio.signInPhotoVersion", 0);
    return view();
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
    return view();
  });

  app.delete("/api/studio/branding/logo", { preHandler: requireOwner }, async () => {
    fs.rmSync(file, { force: true });
    settings.set("studio.logoVersion", 0);
    return view();
  });
}
