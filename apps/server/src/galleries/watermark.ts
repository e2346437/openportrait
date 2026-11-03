import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import opentype from "opentype.js";
import sharp, { type OverlayOptions } from "sharp";
import { z } from "zod";

const require = createRequire(import.meta.url);

/** Fonts a watermark can use. They ship with the app (@fontsource), so the result never depends on what the host has installed. */
export const WATERMARK_FONTS = {
  inter: { label: "Inter, sans", pkg: "inter" },
  "dm-sans": { label: "DM Sans, sans", pkg: "dm-sans" },
  montserrat: { label: "Montserrat, sans", pkg: "montserrat" },
  lora: { label: "Lora, serif", pkg: "lora" },
  "playfair-display": { label: "Playfair Display, serif", pkg: "playfair-display" },
  "cormorant-garamond": { label: "Cormorant Garamond, serif", pkg: "cormorant-garamond" },
} as const;
export type WatermarkFont = keyof typeof WATERMARK_FONTS;
const FONT_KEYS = Object.keys(WATERMARK_FONTS) as [WatermarkFont, ...WatermarkFont[]];

export const POSITIONS = ["tile", "top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;

export const WatermarkSpec = z.object({
  /** Text wording, the studio logo, or a custom image. */
  mode: z.enum(["text", "logo", "image"]).default("text"),
  font: z.enum(FONT_KEYS).default("inter"),
  style: z.enum(["regular", "bold", "italic"]).default("bold"),
  /** #rrggbb */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #ffffff.").default("#ffffff"),
  /** Text height in pixels on a 1600 px wide image; scaled to every preview size. */
  textSize: z.number().int().min(20).max(200).default(60),
  /** Percent of the image width that a logo or custom image covers. */
  size: z.number().int().min(8).max(80).default(24),
  /** 10 to 100 percent. */
  opacity: z.number().int().min(10).max(100).default(45),
  position: z.enum(POSITIONS).default("tile"),
});
export type WatermarkSpec = z.infer<typeof WatermarkSpec>;
export const DEFAULT_WATERMARK: WatermarkSpec = WatermarkSpec.parse({});

/** Everything the renderer needs besides the photo. Image files may be missing, in which case it falls back to text. */
export interface WatermarkInput {
  spec: WatermarkSpec;
  /** Wording for text mode (and the fallback). */
  text: string;
  logoFile: string | null;
  imageFile: string | null;
  /** Bumped when the logo or custom image changes, so the fingerprint changes with it. */
  logoVersion: number;
  imageVersion: number;
}

/** Short fingerprint of everything that changes how a mark looks, so an edit gives photos new URLs and new files. */
export function watermarkHash(w: WatermarkInput): string {
  const v = w.spec.mode === "logo" ? w.logoVersion : w.spec.mode === "image" ? w.imageVersion : 0;
  return crypto.createHash("sha1").update(JSON.stringify([w.spec, w.spec.mode === "text" ? w.text : "", v])).digest("hex").slice(0, 8);
}

// ---- fonts -------------------------------------------------------------------------------------------------------

const loaded = new Map<string, opentype.Font>();
function loadFont(key: WatermarkFont, style: WatermarkSpec["style"]): opentype.Font {
  const weight = style === "bold" ? 700 : 400;
  const slant = style === "italic" ? "italic" : "normal";
  const id = `${key}-${weight}-${slant}`;
  let font = loaded.get(id);
  if (!font) {
    const dir = path.dirname(require.resolve(`@fontsource/${WATERMARK_FONTS[key].pkg}/package.json`));
    const file = path.join(dir, "files", `${WATERMARK_FONTS[key].pkg}-latin-${weight}-${slant}.woff`);
    const buf = fs.readFileSync(file);
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    loaded.set(id, font);
  }
  return font;
}

/** Text as an SVG path, so nothing depends on fonts installed on the host. */
function textPath(text: string, spec: WatermarkSpec, fontSize: number): { d: string; width: number; height: number } {
  const font = loadFont(spec.font, spec.style);
  const p = font.getPath(text, 0, 0, fontSize);
  const box = p.getBoundingBox();
  // Shift so the ink starts at 0,0.
  const shifted = font.getPath(text, -box.x1, -box.y1, fontSize);
  return { d: shifted.toPathData(2), width: Math.ceil(box.x2 - box.x1), height: Math.ceil(box.y2 - box.y1) };
}

// ---- rendering ---------------------------------------------------------------------------------------------------

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function place(position: WatermarkSpec["position"], w: number, h: number, mw: number, mh: number): { left: number; top: number } {
  const m = Math.round(Math.min(w, h) * 0.04);
  const x = position.includes("left") ? m : position.includes("right") ? w - mw - m : Math.round((w - mw) / 2);
  const y = position.startsWith("top") ? m : position.startsWith("bottom") ? h - mh - m : Math.round((h - mh) / 2);
  return { left: Math.max(0, x), top: Math.max(0, y) };
}

/** The mark itself as a transparent PNG, sized for an image of width w. Never larger than the source art. */
async function artwork(w: WatermarkInput, imgW: number): Promise<Buffer | null> {
  const file = w.spec.mode === "logo" ? w.logoFile : w.spec.mode === "image" ? w.imageFile : null;
  if (!file || !fs.existsSync(file)) return null;
  const width = Math.max(16, Math.round((imgW * w.spec.size) / 100));
  const { data } = await sharp(file)
    .resize({ width, withoutEnlargement: true })
    .ensureAlpha()
    // Scale the alpha channel by the chosen opacity.
    .linear([1, 1, 1, w.spec.opacity / 100], [0, 0, 0, 0])
    .png()
    .toBuffer({ resolveWithObject: true });
  return data;
}

/** An SVG layer carrying the text mark, either one placed mark or a diagonal repeat. */
function textLayer(w: WatermarkInput, imgW: number, imgH: number): string {
  const { spec } = w;
  const fontSize = Math.max(10, Math.round((imgW * spec.textSize) / 1600));
  const t = textPath(w.text, spec, fontSize);
  const op = spec.opacity / 100;
  // A thin edge in the opposite tone keeps the mark readable on both light and dark photos.
  const edge = luminance(spec.color) > 0.5 ? "#000000" : "#ffffff";
  const art = (x: number, y: number) =>
    `<path transform="translate(${x} ${y})" d="${t.d}" fill="${spec.color}" fill-opacity="${op}" stroke="${edge}" stroke-opacity="${op * 0.5}" stroke-width="${Math.max(1, fontSize / 22)}" paint-order="stroke" stroke-linejoin="round"/>`;
  if (spec.position === "tile") {
    const stepX = Math.round(t.width + fontSize * 2.2);
    const stepY = Math.round(t.height + fontSize * 2.6);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}"><defs><pattern id="w" width="${stepX}" height="${stepY}" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)">${art(fontSize * 0.5, fontSize * 0.6)}</pattern></defs><rect width="100%" height="100%" fill="url(#w)"/></svg>`;
  }
  const { left, top } = place(spec.position, imgW, imgH, t.width, t.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">${art(left, top)}</svg>`;
}

/**
 * Lays the studio's mark (wording, logo or custom image) over a preview. Only ever applied to previews and
 * thumbnails; downloads are the untouched files. The mark is scaled to each image, so one setting looks the same at
 * every size.
 */
export async function renderWatermarkedBuffer(base: string | Buffer, w: WatermarkInput): Promise<Buffer> {
  const img = sharp(base);
  const { width = 0, height = 0 } = await img.metadata();
  let composite: OverlayOptions;
  const art = w.spec.mode === "text" ? null : await artwork(w, width);
  if (!art) {
    composite = { input: Buffer.from(textLayer(w, width, height)) };
  } else if (w.spec.position === "tile") {
    const m = await sharp(art).metadata();
    const gap = Math.round((m.width ?? 0) * 0.6);
    const tile = await sharp(art).extend({ right: gap, bottom: gap, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    composite = { input: tile, tile: true };
  } else {
    const m = await sharp(art).metadata();
    composite = { input: art, ...place(w.spec.position, width, height, m.width ?? 0, m.height ?? 0) };
  }
  return img.composite([composite]).webp({ quality: 80, effort: 4 }).toBuffer();
}

export async function renderWatermarked(baseFile: string, dest: string, w: WatermarkInput): Promise<void> {
  const out = await renderWatermarkedBuffer(baseFile, w);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, dest);
}

/** A neutral stand-in photo for previews in Settings, so a mark can be judged on light and dark areas. */
export async function sampleBase(): Promise<Buffer> {
  const w = 1200;
  const h = 800;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8aa0a8"/><stop offset="0.55" stop-color="#c9b79a"/><stop offset="1" stop-color="#4a3f33"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#a)"/><circle cx="880" cy="250" r="120" fill="#f1e6cf" fill-opacity="0.55"/><path d="M0 640 C 250 520 450 700 700 600 S 1050 560 1200 620 V800 H0Z" fill="#2c261f" fill-opacity="0.55"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}
