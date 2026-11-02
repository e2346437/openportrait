import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Fonts a site can use. The first group are system fonts (nothing to download). The rest are bundled with the app
 * and copied into the exported site, so visitors never contact a font service and the site works offline.
 */
export interface SiteFont {
  id: string;
  label: string;
  kind: "serif" | "sans";
  stack: string;
  /** @fontsource package, when the font ships with the app. */
  pkg?: string;
  family?: string;
}

const SERIF_FALLBACK = `Georgia, "Times New Roman", serif`;
const SANS_FALLBACK = `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

export const FONTS: SiteFont[] = [
  { id: "system-sans", label: "System sans", kind: "sans", stack: SANS_FALLBACK },
  { id: "georgia", label: "Georgia", kind: "serif", stack: SERIF_FALLBACK },
  { id: "cormorant", label: "Cormorant Garamond", kind: "serif", stack: `"Cormorant Garamond", ${SERIF_FALLBACK}`, pkg: "cormorant-garamond", family: "Cormorant Garamond" },
  { id: "playfair", label: "Playfair Display", kind: "serif", stack: `"Playfair Display", ${SERIF_FALLBACK}`, pkg: "playfair-display", family: "Playfair Display" },
  { id: "lora", label: "Lora", kind: "serif", stack: `Lora, ${SERIF_FALLBACK}`, pkg: "lora", family: "Lora" },
  { id: "inter", label: "Inter", kind: "sans", stack: `Inter, ${SANS_FALLBACK}`, pkg: "inter", family: "Inter" },
  { id: "dm-sans", label: "DM Sans", kind: "sans", stack: `"DM Sans", ${SANS_FALLBACK}`, pkg: "dm-sans", family: "DM Sans" },
  { id: "montserrat", label: "Montserrat", kind: "sans", stack: `Montserrat, ${SANS_FALLBACK}`, pkg: "montserrat", family: "Montserrat" },
];

export const fontById = (id: string): SiteFont => FONTS.find((f) => f.id === id) ?? FONTS[0]!;
const WEIGHTS = [400, 700] as const;

const require = createRequire(import.meta.url);
function fontFile(font: SiteFont, weight: number): string | null {
  if (!font.pkg) return null;
  try {
    const dir = path.dirname(require.resolve(`@fontsource/${font.pkg}/package.json`));
    const file = path.join(dir, "files", `${font.pkg}-latin-${weight}-normal.woff2`);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** @font-face rules and the files they point at, for the fonts a theme uses. Paths are relative to assets/. */
export function fontAssets(ids: string[]): { css: string; files: Array<{ name: string; file: string }> } {
  let css = "";
  const files: Array<{ name: string; file: string }> = [];
  for (const id of new Set(ids)) {
    const font = fontById(id);
    for (const w of WEIGHTS) {
      const file = fontFile(font, w);
      if (!file || !font.family) continue;
      const name = `fonts/${font.pkg}-${w}.woff2`;
      files.push({ name, file });
      css += `@font-face{font-family:"${font.family}";font-style:normal;font-weight:${w};font-display:swap;src:url("${name}") format("woff2")}\n`;
    }
  }
  return { css, files };
}
