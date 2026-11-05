import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { z } from "zod";
import { artwork, loadFont, luminance, textPath, watermarkComposite, watermarkHash, type WatermarkInput } from "./watermark.js";

/**
 * Protected Proofing (docs/PROOFING.md): how client previews are made hard to reuse. Previews are re-rendered on the
 * server at a lower size with an irregular, textured mark that is different for every photo. Nothing here is a
 * guarantee against screenshots or AI recreation; it deters casual copying and lowers the value of a stolen preview.
 */

/** Bump when the drawing code changes, so every cached protected file is rebuilt. */
export const PROOF_RENDERER_VERSION = 1;

export const PROOF_MODES = ["light", "balanced", "strong"] as const;
export type ProofMode = (typeof PROOF_MODES)[number];

interface Preset {
  label: string;
  /** Long edge of protected previews, px. A starting point to tune with real photos, not a validated threshold. */
  longEdge: number;
  quality: number;
  /** Space between marks, as a multiple of the text height. Smaller is denser. */
  gap: number;
  /** Largest turn away from the base angle, degrees. */
  rotate: number;
  scale: [number, number];
  /** Multiplier on the studio's chosen opacity, picked per mark. */
  opacity: [number, number];
}

export const PRESETS: Record<ProofMode, Preset> = {
  light: { label: "Light", longEdge: 1800, quality: 80, gap: 3.0, rotate: 6, scale: [0.9, 1.1], opacity: [0.7, 1.0] },
  balanced: { label: "Balanced", longEdge: 1400, quality: 76, gap: 1.8, rotate: 12, scale: [0.8, 1.25], opacity: [0.85, 1.2] },
  strong: { label: "Strong", longEdge: 1000, quality: 72, gap: 1.0, rotate: 18, scale: [0.75, 1.4], opacity: [1.0, 1.4] },
};

export const EDGE_LIMITS = { min: 600, max: 2048 } as const;

/**
 * When previews are protected. "locked" is the long-standing behavior: only while downloads wait for payment. It is
 * separate from the download lock itself, so changing one never silently changes the other.
 */
export const ProofApply = z.enum(["locked", "always", "off"]);
export type ProofApply = z.infer<typeof ProofApply>;

export const ProofingPolicy = z.object({
  mode: z.enum(PROOF_MODES).default("balanced"),
  apply: ProofApply.default("locked"),
  /** Overrides the preset's long edge. Null means use the preset. */
  maxLongEdge: z.number().int().min(EDGE_LIMITS.min).max(EDGE_LIMITS.max).nullable().default(null),
});
export type ProofingPolicy = z.infer<typeof ProofingPolicy>;
/** A gallery stores only what it changes; the rest follows the studio default. */
export const ProofingOverride = z.object({
  mode: z.enum(PROOF_MODES).optional(),
  apply: ProofApply.optional(),
  maxLongEdge: z.number().int().min(EDGE_LIMITS.min).max(EDGE_LIMITS.max).nullable().optional(),
});
export type ProofingOverride = z.infer<typeof ProofingOverride>;
export const DEFAULT_PROOFING: ProofingPolicy = ProofingPolicy.parse({});

/** Studio default plus a gallery's own choices, each validated on its own so one bad stored value can't break the page. */
export function resolveProofing(studio: unknown, gallery: unknown): ProofingPolicy {
  const a = ProofingOverride.safeParse(studio ?? {});
  const b = ProofingOverride.safeParse(gallery ?? {});
  const defined = (o: ProofingOverride) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return ProofingPolicy.parse({ ...(a.success ? defined(a.data) : {}), ...(b.success ? defined(b.data) : {}) });
}

export const edgeOf = (p: ProofingPolicy): number => p.maxLongEdge ?? PRESETS[p.mode].longEdge;

/**
 * Names a protected file. Anything that changes how a preview looks (preset, size, the mark itself, the drawing code)
 * changes it, so an edit gives photos new files and new URLs. `apply` is left out on purpose: it decides whether to
 * protect, not what protection looks like.
 */
export function proofFingerprint(p: ProofingPolicy, wm: WatermarkInput): string {
  return crypto.createHash("sha1").update(JSON.stringify([p.mode, edgeOf(p), watermarkHash(wm), PROOF_RENDERER_VERSION])).digest("hex").slice(0, 8);
}

export function protectedPath(cacheDir: string, galleryId: string, photoId: string, version: number, variant: "thumb" | "preview", fingerprint: string): string {
  return path.join(cacheDir, "galleries", galleryId, `${photoId}-v${version}-${variant}-pf-${fingerprint}.webp`);
}

// ---- deterministic randomness ------------------------------------------------------------------------------------

/** Seeded generator (sfc32). The same seed always draws the same layout, so a photo looks the same on every visit. */
export function rng(seedHex: string): () => number {
  const h = crypto.createHash("sha256").update(seedHex).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}
const between = (r: () => number, [lo, hi]: [number, number]) => lo + (hi - lo) * r();
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ---- text marks --------------------------------------------------------------------------------------------------

function shade(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => clamp(Math.round(v + delta * 255), 0, 255).toString(16).padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

/** The wording as one path whose letters sit slightly off the baseline and off an even rhythm. */
function wobblyPath(text: string, spec: WatermarkInput["spec"], fontSize: number, r: () => number): string {
  const font = loadFont(spec.font, spec.style);
  const box = font.getPath(text, 0, 0, fontSize).getBoundingBox();
  const scale = fontSize / font.unitsPerEm;
  let x = -box.x1;
  const out: string[] = [];
  for (const ch of Array.from(text)) {
    const glyph = font.charToGlyph(ch);
    const dy = (r() - 0.5) * fontSize * 0.1;
    out.push(glyph.getPath(x, -box.y1 + dy, fontSize).toPathData(2));
    x += (glyph.advanceWidth ?? 0) * scale * (1 + (r() - 0.5) * 0.14);
  }
  return out.join("");
}

function textMarks(w: WatermarkInput, preset: Preset, imgW: number, imgH: number, r: () => number): string {
  const { spec } = w;
  const fontSize = Math.max(10, Math.round((imgW * spec.textSize) / 1600));
  const flat = textPath(w.text, spec, fontSize);
  const edge = luminance(spec.color) > 0.5 ? "#000000" : "#ffffff";
  const sw = Math.max(1, fontSize / 22);
  const cell = Math.max(5, fontSize / 14);

  // Three versions of the wording, each with its own letter wobble, tone and fine hatching inside the letters.
  const variants = [0, 1, 2].map((i) => {
    const tone = shade(spec.color, (r() - 0.5) * 0.16);
    const angle = Math.round(r() * 180);
    const id = `v${i}`;
    return `<pattern id="t${id}" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><rect width="${cell}" height="${cell}" fill="${tone}" fill-opacity="0.8"/><rect width="${cell}" height="${(cell * 0.34).toFixed(2)}" fill="${tone}"/></pattern><path id="${id}" d="${wobblyPath(w.text, spec, fontSize, r)}" fill="url(#t${id})" stroke="${edge}" stroke-opacity="0.5" stroke-width="${sw}" paint-order="stroke" stroke-linejoin="round"/>`;
  });

  const stepX = flat.width + fontSize * preset.gap;
  const stepY = flat.height + fontSize * preset.gap * 1.15;
  const reach = Math.hypot(imgW, imgH) / 2;
  const base = -28 + (r() - 0.5) * 16;
  const op0 = spec.opacity / 100;
  let uses = "";
  let count = 0;
  for (let row = 0, y = -reach; y < reach && count < 900; row++, y += stepY) {
    const shift = (row % 2 ? 0.5 : 0) * stepX + r() * stepX * 0.3;
    for (let x = -reach - shift; x < reach && count < 900; x += stepX) {
      const px = x + (r() - 0.5) * stepX * 0.3;
      const py = y + (r() - 0.5) * stepY * 0.3;
      const a = (r() - 0.5) * 2 * preset.rotate;
      const s = between(r, preset.scale);
      const op = clamp(op0 * between(r, preset.opacity), 0.1, 0.92);
      uses += `<use href="#v${Math.floor(r() * 3)}" opacity="${op.toFixed(2)}" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${a.toFixed(1)} ${flat.width / 2} ${flat.height / 2}) scale(${s.toFixed(2)})"/>`;
      count++;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${imgW}" height="${imgH}"><defs>${variants.join("")}</defs><g transform="translate(${imgW / 2} ${imgH / 2}) rotate(${base.toFixed(1)})">${uses}</g></svg>`;
}

// ---- logo and image marks ----------------------------------------------------------------------------------------

async function artMarks(w: WatermarkInput, art: Buffer, preset: Preset, imgW: number, imgH: number, r: () => number): Promise<OverlayOptions[]> {
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const meta = await sharp(art).metadata();
  const aw = meta.width ?? 1;
  const variants = await Promise.all(
    [0, 1, 2, 3].map(async () => {
      const s = between(r, preset.scale);
      const angle = (r() - 0.5) * 2 * preset.rotate;
      const alpha = clamp(between(r, preset.opacity), 0.4, 1.4);
      const buf = await sharp(art)
        .resize({ width: Math.max(8, Math.round(aw * s)) })
        .linear([1, 1, 1, alpha], [0, 0, 0, 0])
        .rotate(angle, { background: clear })
        .png()
        .toBuffer({ resolveWithObject: true });
      return { input: buf.data, w: buf.info.width, h: buf.info.height };
    }),
  );
  let stepX = aw * (1 + preset.gap * 0.55);
  let stepY = (meta.height ?? aw) * (1 + preset.gap * 0.7);
  while (Math.ceil(imgW / stepX) * Math.ceil(imgH / stepY) > 70) {
    stepX *= 1.15;
    stepY *= 1.15;
  }
  const out: OverlayOptions[] = [];
  for (let row = 0, y = r() * -stepY * 0.5; y < imgH; row++, y += stepY) {
    const shift = (row % 2 ? 0.5 : 0) * stepX;
    for (let x = r() * -stepX * 0.5 - shift; x < imgW; x += stepX) {
      const v = variants[Math.floor(r() * variants.length)]!;
      const left = Math.round(x + (r() - 0.5) * stepX * 0.3);
      const top = Math.round(y + (r() - 0.5) * stepY * 0.3);
      if (left + v.w < 0 || top + v.h < 0 || left > imgW || top > imgH) continue;
      // Keep every mark fully on the photo; sharp cannot place a layer partly outside it.
      out.push({ input: v.input, left: clamp(left, 0, Math.max(0, imgW - v.w)), top: clamp(top, 0, Math.max(0, imgH - v.h)) });
    }
  }
  return out;
}

// ---- rendering ---------------------------------------------------------------------------------------------------

/** The server-held seed for a photo's layout. Different per gallery and photo, so two copies can't be lined up and subtracted. */
export function layoutSeed(sign: (purpose: string, data: string) => string, galleryId: string, photoId: string): string {
  return sign("proof-layout", `${galleryId}:${photoId}:${PROOF_RENDERER_VERSION}`);
}

/**
 * A protected copy of a clean preview or thumbnail: smaller, with an irregular textured mark baked into the pixels.
 * Always done on the server before encoding, never as an overlay the browser could hide.
 */
export async function renderProtectedBuffer(base: string | Buffer, w: WatermarkInput, policy: ProofingPolicy, seed: string, kind: "thumb" | "preview" = "preview"): Promise<Buffer> {
  const preset = PRESETS[policy.mode];
  const edge = edgeOf(policy);
  const box = kind === "thumb" ? { width: Math.min(1280, edge), height: Math.min(640, edge) } : { width: edge, height: edge };
  const { data, info } = await sharp(base, { failOn: "none" })
    .rotate()
    .resize({ ...box, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .removeAlpha()
    .png({ compressionLevel: 1 })
    .toBuffer({ resolveWithObject: true });
  const r = rng(seed);
  let layers: OverlayOptions[];
  const art = w.spec.mode === "text" ? null : await artwork(w, info.width);
  if (w.spec.position !== "tile") layers = [await watermarkComposite(w, info.width, info.height)];
  else if (art) layers = await artMarks(w, art, preset, info.width, info.height, r);
  else layers = [{ input: Buffer.from(textMarks(w, preset, info.width, info.height, r)) }];
  // No metadata is carried over: the output has no EXIF, GPS or camera data.
  return sharp(data).composite(layers).webp({ quality: preset.quality, effort: 4 }).toBuffer();
}

const inflight = new Map<string, Promise<void>>();
let running = 0;
const waiting: Array<() => void> = [];
const MAX_PARALLEL = 3;

/** Writes the protected file if it isn't there. Renders of the same file share one job, and only a few run at once. */
export function ensureProtected(dest: string, baseFile: string, w: WatermarkInput, policy: ProofingPolicy, seed: string, kind: "thumb" | "preview"): Promise<void> {
  if (fs.existsSync(dest)) return Promise.resolve();
  let job = inflight.get(dest);
  if (!job) {
    job = (async () => {
      if (running >= MAX_PARALLEL) await new Promise<void>((go) => waiting.push(go));
      running++;
      try {
        if (fs.existsSync(dest)) return;
        const out = await renderProtectedBuffer(baseFile, w, policy, seed, kind);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, dest);
      } finally {
        running--;
        waiting.shift()?.();
        inflight.delete(dest);
      }
    })();
    inflight.set(dest, job);
  }
  return job;
}

const pruned = new Set<string>();
/** Removes protected files made under an older look, once per gallery and look, so edits don't pile up in the cache. */
export function pruneProtected(cacheDir: string, galleryId: string, keep: string): void {
  const key = `${galleryId}:${keep}`;
  if (pruned.has(key)) return;
  pruned.add(key);
  const dir = path.join(cacheDir, "galleries", galleryId);
  try {
    for (const n of fs.readdirSync(dir)) {
      if (/-(?:pf|wm)-[a-f0-9]{8}\.webp$/.test(n) && !n.endsWith(`-pf-${keep}.webp`)) fs.rmSync(path.join(dir, n), { force: true });
    }
  } catch {
    /* the folder may not exist yet */
  }
}
