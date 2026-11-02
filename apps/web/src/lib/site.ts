/** Types for the website builder, matching apps/server/src/site/types.ts. */
export const PAGE_IDS = ["home", "portfolio", "about", "services", "contact"] as const;
export type PageId = (typeof PAGE_IDS)[number];

export type Block =
  | { id: string; type: "hero"; heading: string; subheading: string; photoId: string; buttonLabel: string; buttonTarget: string; height: "full" | "tall" | "short"; align: "left" | "center" }
  | { id: string; type: "text"; heading: string; body: string; align: "left" | "center" }
  | { id: string; type: "gallery"; heading: string; photoIds: string[]; layout: "auto" | "grid" | "masonry" | "rows"; columns: 2 | 3 | 4 }
  | { id: string; type: "imageText"; heading: string; body: string; photoId: string; side: "left" | "right" }
  | { id: string; type: "services"; heading: string; intro: string; items: Array<{ name: string; price: string; description: string }> }
  | { id: string; type: "testimonials"; heading: string; items: Array<{ quote: string; author: string }> }
  | { id: string; type: "contact"; heading: string; intro: string }
  | { id: string; type: "cta"; heading: string; body: string; buttonLabel: string; buttonTarget: string };
export type BlockType = Block["type"];

export interface Theme {
  bg: string;
  text: string;
  muted: string;
  accent: string;
  headingFont: string;
  bodyFont: string;
  headingSize: "s" | "m" | "l";
  corners: "square" | "soft" | "round";
}

export interface PageConfig {
  enabled: boolean;
  title: string;
  nav: string;
  description: string;
  blocks: Block[];
}

export interface SiteConfig {
  version: 1;
  template: string;
  name: string;
  tagline: string;
  siteUrl: string;
  useLogo: boolean;
  theme: Theme;
  contact: { email: string; phone: string; location: string; links: Array<{ label: string; url: string }> };
  seo: { description: string; sharePhotoId: string };
  footer: { text: string };
  pages: Record<PageId, PageConfig>;
  photos: Record<string, { alt: string; caption: string }>;
  extras: Record<string, unknown>;
}

export interface OptionField {
  key: string;
  label: string;
  type: "text" | "textarea" | "toggle" | "list";
  hint?: string;
  columns?: Array<{ key: string; label: string; type: "text" | "textarea" | "date" }>;
  placeholder?: string;
}

export interface SiteTemplateInfo {
  id: string;
  name: string;
  description: string;
  header: "centered" | "split" | "overlay";
  gallery: "masonry" | "grid" | "rows";
  theme: Theme;
  extra: boolean;
}

export interface SiteState {
  config: SiteConfig;
  saved: boolean;
  lastExportedAt: number | null;
  templates: SiteTemplateInfo[];
  fonts: Array<{ id: string; label: string; kind: "serif" | "sans"; stack: string }>;
  options: Array<{ extension: string; title: string; fields: OptionField[] }>;
  hasLogo: boolean;
  publicUrl: string;
}

export interface SiteReport {
  warnings: string[];
  pages: number;
  photos: number;
  files: number;
  bytes: number;
  template: string;
}

export interface PickPhoto {
  id: string;
  thumb?: string;
  filename?: string;
  width?: number | null;
  height?: number | null;
  missing?: boolean;
  set?: string;
}

export const BLOCK_LABELS: Record<BlockType, { label: string; hint: string }> = {
  hero: { label: "Hero", hint: "A big opening photo with a headline" },
  gallery: { label: "Photo gallery", hint: "A grid of your photos" },
  text: { label: "Text", hint: "A heading and a few paragraphs" },
  imageText: { label: "Photo and text", hint: "A photo beside your words" },
  services: { label: "Services and pricing", hint: "Cards for sessions and prices" },
  testimonials: { label: "Testimonials", hint: "Quotes from happy clients" },
  contact: { label: "Contact details", hint: "Email, phone and links" },
  cta: { label: "Call to action", hint: "A banner with one button" },
};

export const PAGE_LABELS: Record<PageId, string> = { home: "Home", portfolio: "Portfolio", about: "About", services: "Services", contact: "Contact" };

export function blankBlock(type: BlockType): Block {
  const id = Math.random().toString(36).slice(2, 9);
  switch (type) {
    case "hero":
      return { id, type, heading: "Your headline", subheading: "", photoId: "", buttonLabel: "", buttonTarget: "", height: "tall", align: "left" };
    case "text":
      return { id, type, heading: "", body: "", align: "left" };
    case "gallery":
      return { id, type, heading: "", photoIds: [], layout: "auto", columns: 3 };
    case "imageText":
      return { id, type, heading: "", body: "", photoId: "", side: "left" };
    case "services":
      return { id, type, heading: "Services", intro: "", items: [{ name: "Portrait session", price: "", description: "" }] };
    case "testimonials":
      return { id, type, heading: "Kind words", items: [{ quote: "", author: "" }] };
    case "contact":
      return { id, type, heading: "Get in touch", intro: "" };
    case "cta":
      return { id, type, heading: "Let's work together", body: "", buttonLabel: "Send an inquiry", buttonTarget: "inquire" };
  }
}

/** Photo ids a config names, for thumbnail lookups. */
export function photoIdsOf(c: SiteConfig): string[] {
  const ids = new Set<string>();
  if (c.seo.sharePhotoId) ids.add(c.seo.sharePhotoId);
  for (const p of Object.values(c.pages)) for (const b of p.blocks) {
    if ((b.type === "hero" || b.type === "imageText") && b.photoId) ids.add(b.photoId);
    if (b.type === "gallery") b.photoIds.forEach((i) => ids.add(i));
  }
  return [...ids];
}
