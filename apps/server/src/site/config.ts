import crypto from "node:crypto";
import { FONTS } from "./fonts.js";
import { FREE_TEMPLATES } from "./templates.js";
import { BLOCK_TYPES, PAGE_IDS, type Block, type BlockType, type PageConfig, type PageId, type SiteConfig, type Theme } from "./types.js";

const newId = () => crypto.randomBytes(5).toString("base64url");

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown, fallback: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fallback);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.replace(/\r\n/g, "\n").slice(0, max) : "");
const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A web or mail address that is safe to put in a link; anything else becomes empty. */
export function safeUrl(v: unknown): string {
  const s = str(v, 500).trim();
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) {
    try {
      if (/^https?:/i.test(s)) new URL(s);
      return s;
    } catch {
      return "";
    }
  }
  return "";
}

/** Site address with no trailing slash, https only (http allowed for local testing). */
function siteUrl(v: unknown): string {
  const s = str(v, 200).trim().replace(/\/+$/, "");
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
  } catch {
    return "";
  }
}

const target = (v: unknown): string => {
  const s = str(v, 500).trim();
  if (s === "inquire" || /^page:(home|portfolio|about|services|contact)$/.test(s)) return s;
  return safeUrl(s);
};

export function cleanTheme(v: unknown, fallback: Theme): Theme {
  const t = obj(v);
  const fonts = FONTS.map((f) => f.id);
  return {
    bg: hex(t.bg, fallback.bg),
    text: hex(t.text, fallback.text),
    muted: hex(t.muted, fallback.muted),
    accent: hex(t.accent, fallback.accent),
    headingFont: oneOf(t.headingFont, fonts, fallback.headingFont as string),
    bodyFont: oneOf(t.bodyFont, fonts, fallback.bodyFont as string),
    headingSize: oneOf(t.headingSize, ["s", "m", "l"] as const, fallback.headingSize),
    corners: oneOf(t.corners, ["square", "soft", "round"] as const, fallback.corners),
  };
}

export function newBlock(type: BlockType): Block {
  const id = newId();
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

function cleanBlock(raw: unknown): Block | null {
  const b = obj(raw);
  const type = oneOf(b.type, BLOCK_TYPES, "" as BlockType);
  if (!type) return null;
  const id = typeof b.id === "string" && /^[\w-]{1,24}$/.test(b.id) ? b.id : newId();
  const photo = (v: unknown) => (typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : "");
  switch (type) {
    case "hero":
      return { id, type, heading: str(b.heading, 200), subheading: str(b.subheading, 400), photoId: photo(b.photoId), buttonLabel: str(b.buttonLabel, 60), buttonTarget: target(b.buttonTarget), height: oneOf(b.height, ["full", "tall", "short"] as const, "tall"), align: oneOf(b.align, ["left", "center"] as const, "left") };
    case "text":
      return { id, type, heading: str(b.heading, 200), body: str(b.body, 8000), align: oneOf(b.align, ["left", "center"] as const, "left") };
    case "gallery":
      return { id, type, heading: str(b.heading, 200), photoIds: arr(b.photoIds).map(photo).filter(Boolean).slice(0, 200), layout: oneOf(b.layout, ["auto", "grid", "masonry", "rows"] as const, "auto"), columns: oneOf(Number(b.columns), [2, 3, 4] as const, 3) };
    case "imageText":
      return { id, type, heading: str(b.heading, 200), body: str(b.body, 8000), photoId: photo(b.photoId), side: oneOf(b.side, ["left", "right"] as const, "left") };
    case "services":
      return { id, type, heading: str(b.heading, 200), intro: str(b.intro, 1000), items: arr(b.items).slice(0, 24).map((i) => ({ name: str(obj(i).name, 120), price: str(obj(i).price, 60), description: str(obj(i).description, 1200) })) };
    case "testimonials":
      return { id, type, heading: str(b.heading, 200), items: arr(b.items).slice(0, 24).map((i) => ({ quote: str(obj(i).quote, 1200), author: str(obj(i).author, 120) })) };
    case "contact":
      return { id, type, heading: str(b.heading, 200), intro: str(b.intro, 1000) };
    case "cta":
      return { id, type, heading: str(b.heading, 200), body: str(b.body, 1000), buttonLabel: str(b.buttonLabel, 60), buttonTarget: target(b.buttonTarget) };
  }
}

/** A starting site: every page has sensible blocks, so the owner edits words and picks photos instead of building from nothing. */
export function defaultSite(studioName: string): SiteConfig {
  const t = FREE_TEMPLATES[0]!;
  const name = studioName.trim() || "Your Studio";
  const b = <T extends BlockType>(type: T, patch: Partial<Extract<Block, { type: T }>>) => ({ ...newBlock(type), ...patch }) as Block;
  const page = (title: string, nav: string, description: string, blocks: Block[], enabled = true): PageConfig => ({ enabled, title, nav, description, blocks });
  return {
    version: 1,
    template: t.id,
    name,
    tagline: "Photography",
    siteUrl: "",
    useLogo: false,
    theme: { ...t.theme },
    contact: { email: "", phone: "", location: "", links: [] },
    seo: { description: "", sharePhotoId: "" },
    footer: { text: `© ${new Date().getFullYear()} ${name}` },
    pages: {
      home: page("Home", "Home", "", [
        b("hero", { heading: name, subheading: "Photography with a point of view.", buttonLabel: "See the work", buttonTarget: "page:portfolio", height: "tall" }),
        b("gallery", { heading: "Recent work", layout: "auto" }),
        b("cta", { heading: "Let's make something together", body: "Tell me about your session and we'll find a date.", buttonLabel: "Send an inquiry", buttonTarget: "inquire" }),
      ]),
      portfolio: page("Portfolio", "Portfolio", "", [b("gallery", { heading: "Portfolio", layout: "auto" })]),
      about: page("About", "About", "", [b("imageText", { heading: "Hello, I'm the photographer", body: "Write a few lines about you and how you work. What do you love photographing, and what is it like to be photographed by you?" })]),
      services: page("Services", "Services", "", [b("services", { heading: "Sessions and pricing", intro: "Every session includes planning, the shoot and a private online gallery." })], false),
      contact: page("Contact", "Contact", "", [b("contact", { heading: "Get in touch", intro: "Tell me what you have in mind." })]),
    },
    photos: {},
    extras: {},
  };
}

function cleanPage(raw: unknown, fallback: PageConfig): PageConfig {
  const p = obj(raw);
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : fallback.enabled,
    title: str(p.title, 120) || fallback.title,
    nav: str(p.nav, 40) || fallback.nav,
    description: str(p.description, 300),
    blocks: arr(p.blocks).map(cleanBlock).filter((x): x is Block => !!x).slice(0, 40),
  };
}

/**
 * Turns whatever the browser sent into a valid config. Unknown keys are dropped, text is length-capped, colors,
 * fonts and links are checked, so a saved site can never hold markup or an unsafe link.
 */
export function cleanConfig(raw: unknown, studioName: string): SiteConfig {
  const d = defaultSite(studioName);
  const c = obj(raw);
  const pagesIn = obj(c.pages);
  const pages = Object.fromEntries(PAGE_IDS.map((id) => [id, cleanPage(pagesIn[id], d.pages[id])])) as Record<PageId, PageConfig>;
  const notes: SiteConfig["photos"] = {};
  for (const [id, n] of Object.entries(obj(c.photos)).slice(0, 1000)) {
    if (/^[\w-]{1,40}$/.test(id)) notes[id] = { alt: str(obj(n).alt, 300), caption: str(obj(n).caption, 300) };
  }
  const template = typeof c.template === "string" && c.template.length < 40 ? c.template : d.template;
  const contact = obj(c.contact);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj(c.extras)).slice(0, 200)) {
    if (!/^[a-z0-9-]{1,32}\.[\w-]{1,40}$/.test(k)) continue;
    const json = JSON.stringify(v ?? null);
    if (json.length <= 200_000) extras[k] = JSON.parse(json);
  }
  return {
    version: 1,
    template, // an uninstalled template id is kept, so it comes back with its extension
    name: str(c.name, 120) || d.name,
    tagline: str(c.tagline, 160),
    siteUrl: siteUrl(c.siteUrl),
    useLogo: c.useLogo === true,
    theme: cleanTheme(c.theme, d.theme),
    contact: {
      email: str(contact.email, 200).trim(),
      phone: str(contact.phone, 60).trim(),
      location: str(contact.location, 200).trim(),
      links: arr(contact.links)
        .slice(0, 12)
        .map((l) => ({ label: str(obj(l).label, 40).trim(), url: safeUrl(obj(l).url) }))
        .filter((l) => l.label && l.url),
    },
    seo: { description: str(obj(c.seo).description, 300), sharePhotoId: /^[\w-]{1,40}$/.test(String(obj(c.seo).sharePhotoId ?? "")) ? String(obj(c.seo).sharePhotoId) : "" },
    footer: { text: str(obj(c.footer).text, 300) },
    pages,
    photos: notes,
    extras,
  };
}

/** Every photo id the site uses, in no particular order. Only these are ever read and exported. */
export function usedPhotoIds(config: SiteConfig): string[] {
  const ids = new Set<string>();
  if (config.seo.sharePhotoId) ids.add(config.seo.sharePhotoId);
  for (const id of PAGE_IDS) {
    const page = config.pages[id];
    if (!page.enabled) continue;
    for (const b of page.blocks) {
      if (b.type === "hero" || b.type === "imageText") b.photoId && ids.add(b.photoId);
      if (b.type === "gallery") b.photoIds.forEach((p) => ids.add(p));
    }
  }
  return [...ids];
}
