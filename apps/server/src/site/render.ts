import crypto from "node:crypto";
import { BASE_CSS, SITE_JS } from "./base-css.js";
import { fontAssets, fontById } from "./fonts.js";
import type { PreparedImage } from "./images.js";
import { siteExtensions, siteTemplate, type ExtraPage, type RenderContext, type SiteTemplate } from "./registry.js";
import { FREE_TEMPLATES } from "./templates.js";
import { PAGE_IDS, type Block, type PageId, type SiteConfig } from "./types.js";

export type SiteFile = { path: string; text: string } | { path: string; file: string } | { path: string; bytes: Buffer };

export interface RenderInput {
  config: SiteConfig;
  /** Public address of this studio's inquiry form, or "" when the studio has no public address. */
  inquireUrl: string;
  /** Studio logo and a small icon made from it, when the site uses the logo. */
  logo: { png: Buffer; icon: Buffer } | null;
  images: Map<string, PreparedImage>;
  share: { name: string; file: string } | null;
}

export interface RenderResult {
  files: SiteFile[];
  warnings: string[];
  template: SiteTemplate;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paragraphs = (body: string) =>
  body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
const hash8 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);

const HEADING_SCALE = { s: 0.85, m: 1, l: 1.2 } as const;
const RADIUS = { square: "0px", soft: "6px", round: "14px" } as const;

interface PageOut {
  path: string; // file path in the site, "index.html" or "<slug>/index.html"
  href: string; // link target from the site root, "" or "<slug>/"
  title: string;
  nav: string | null;
  description: string;
  blocks: string;
  overlay: boolean;
  id: PageId | string;
}

export function renderSite(input: RenderInput): RenderResult {
  const { config } = input;
  const warnings: string[] = [];
  let template = siteTemplate(config.template);
  if (!template) {
    template = FREE_TEMPLATES[0]!;
    warnings.push(`The template "${config.template}" isn't available (an extension may be off), so the site uses ${template.name}.`);
  }
  const extensions = siteExtensions();
  const ctxFor = (extId: string): RenderContext => ({ config, esc, option: <T,>(key: string) => config.extras[`${extId}.${key}`] as T | undefined });
  const guard = <T,>(extId: string, what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      warnings.push(`${extId}: ${what} failed (${(err as Error).message}).`);
      return fallback;
    }
  };

  const photoTag = (id: string, opts: { sizes: string; eager?: boolean; cls?: string }): string => {
    const img = input.images.get(id);
    if (!img) return "";
    const note = config.photos[id];
    const biggest = img.files.at(-1)!;
    const mid = img.files.find((f) => f.width >= 1000) ?? biggest;
    const srcset = img.files.map((f) => `__BASE__${f.name} ${f.width}w`).join(", ");
    return `<img src="__BASE__${mid.name}" srcset="${srcset}" sizes="${opts.sizes}" width="${img.width}" height="${img.height}" alt="${esc(note?.alt ?? "")}" ${opts.eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"${opts.cls ? ` class="${opts.cls}"` : ""}>`;
  };

  const resolveTarget = (t: string): string | null => {
    if (!t) return null;
    if (t === "inquire") return input.inquireUrl || null;
    const m = /^page:(\w+)$/.exec(t);
    if (m) return config.pages[m[1] as PageId]?.enabled ? `__BASE__${m[1] === "home" ? "" : `${m[1]}/`}` : null;
    return t;
  };
  const button = (label: string, t: string, cls = ""): string => {
    const href = label ? resolveTarget(t) : null;
    if (label && t && !href) warnings.push(`The button "${label}" has no destination yet (${t === "inquire" ? "set your public address in Settings > Internet so the inquiry form has a web address" : "that page is switched off"}), so it was left out.`);
    return href ? `<a class="btn ${cls}" href="${esc(href)}">${esc(label)}</a>` : "";
  };

  let firstHeading = true;
  const heading = (text: string, cls = ""): string => {
    if (!text) return "";
    const tag = firstHeading ? "h1" : "h2";
    firstHeading = false;
    return `<${tag}${cls ? ` class="${cls}"` : ""}>${esc(text)}</${tag}>`;
  };

  const galleryHtml = (b: Extract<Block, { type: "gallery" }>): string => {
    const layout = b.layout === "auto" ? template.gallery : b.layout;
    const ids = b.photoIds.filter((id) => input.images.has(id));
    const dropped = b.photoIds.length - ids.length;
    if (dropped) warnings.push(`${dropped} photo${dropped > 1 ? "s" : ""} in a gallery section are no longer available and were left out.`);
    const h = heading(b.heading);
    if (!ids.length) return `<section class="blk"><div class="wrap">${h}<div class="empty">Photos you pick for this section appear here.</div></div></section>`;
    const items = ids
      .map((id) => {
        const img = input.images.get(id)!;
        const note = config.photos[id];
        const ratio = img.width / Math.max(1, img.height);
        const full = img.files.at(-1)!;
        const attrs = `href="__BASE__${full.name}" data-full="__BASE__${full.name}" data-alt="${esc(note?.alt ?? "")}" data-cap="${esc(note?.caption ?? "")}"`;
        const style = layout === "rows" ? ` style="--r:${ratio.toFixed(3)}"` : "";
        const sizes = layout === "masonry" ? "(max-width:720px) 50vw, 33vw" : layout === "grid" ? "(max-width:720px) 50vw, 33vw" : `(max-width:720px) 50vw, ${Math.round(ratio * 35)}vw`;
        return `<a ${attrs}${style}>${photoTag(id, { sizes })}</a>`;
      })
      .join("\n");
    return `<section class="blk"><div class="wrap">${h}<div class="gallery ${layout}" style="--cols:${b.columns}">\n${items}\n</div></div></section>`;
  };

  const blockHtml = (b: Block): string => {
    switch (b.type) {
      case "hero": {
        const has = b.photoId && input.images.has(b.photoId);
        if (b.photoId && !has) warnings.push("A hero photo is no longer available, so that section shows no photo.");
        const h = heading(b.heading);
        return `<section class="blk blk-hero h-${b.height} a-${b.align}${has ? "" : " noimg"}">${has ? `<div class="hero-img">${photoTag(b.photoId, { sizes: "100vw", eager: true })}</div>` : ""}<div class="wrap">${h}${b.subheading ? `<p class="sub">${esc(b.subheading)}</p>` : ""}${button(b.buttonLabel, b.buttonTarget)}</div></section>`;
      }
      case "text":
        return `<section class="blk${b.align === "center" ? " center" : ""}"><div class="wrap">${heading(b.heading)}<div class="prose">${paragraphs(b.body)}</div></div></section>`;
      case "gallery":
        return galleryHtml(b);
      case "imageText": {
        const has = b.photoId && input.images.has(b.photoId);
        const img = has ? `<div class="split-img">${photoTag(b.photoId, { sizes: "(max-width:820px) 100vw, 50vw" })}</div>` : "";
        return `<section class="blk"><div class="wrap"><div class="split ${b.side}" ${has ? "" : 'style="grid-template-columns:1fr"'}>${img}<div>${heading(b.heading)}<div class="prose">${paragraphs(b.body)}</div></div></div></div></section>`;
      }
      case "services":
        return `<section class="blk"><div class="wrap">${heading(b.heading)}${b.intro ? `<p class="lead">${esc(b.intro)}</p>` : ""}<div class="services">${b.items
          .filter((i) => i.name)
          .map((i) => `<div class="card"><h3>${esc(i.name)}</h3>${i.price ? `<p class="price">${esc(i.price)}</p>` : ""}${paragraphs(i.description)}</div>`)
          .join("")}</div></div></section>`;
      case "testimonials":
        return `<section class="blk"><div class="wrap">${heading(b.heading)}<div class="quotes">${b.items
          .filter((i) => i.quote)
          .map((i) => `<figure style="margin:0"><blockquote>“${esc(i.quote)}”</blockquote>${i.author ? `<cite>${esc(i.author)}</cite>` : ""}</figure>`)
          .join("")}</div></div></section>`;
      case "contact": {
        const c = config.contact;
        const rows: string[] = [];
        if (c.email) rows.push(`<dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>`);
        if (c.phone) rows.push(`<dt>Phone</dt><dd><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></dd>`);
        if (c.location) rows.push(`<dt>Based in</dt><dd>${esc(c.location)}</dd>`);
        if (c.links.length) rows.push(`<dt>Elsewhere</dt><dd>${c.links.map((l) => `<a href="${esc(l.url)}" rel="noopener me">${esc(l.label)}</a>`).join(" · ")}</dd>`);
        const inquire = button("Send an inquiry", "inquire");
        if (!rows.length && !inquire) warnings.push("The contact section is empty. Add an email, phone or link under Details, and set your public address so the inquiry form can be linked.");
        return `<section class="blk"><div class="wrap">${heading(b.heading)}${b.intro ? `<p class="lead">${esc(b.intro)}</p>` : ""}<div class="contact-grid"><dl>${rows.join("")}</dl>${inquire ? `<div>${inquire}</div>` : ""}</div></div></section>`;
      }
      case "cta":
        return `<section class="blk blk-cta"><div class="wrap">${heading(b.heading)}${b.body ? `<p class="lead">${esc(b.body)}</p>` : ""}${button(b.buttonLabel, b.buttonTarget)}</div></section>`;
    }
  };

  // ---- pages
  const pages: PageOut[] = [];
  for (const id of PAGE_IDS) {
    const p = config.pages[id];
    if (!p.enabled) continue;
    const first = p.blocks[0];
    const overlay = template.header === "overlay" && first?.type === "hero" && !!first.photoId && input.images.has(first.photoId);
    firstHeading = true;
    const blocks = p.blocks.map((b) => blockHtml(b)).join("\n");
    if (!p.blocks.length) warnings.push(`The ${p.nav} page has no sections.`);
    pages.push({ id, path: id === "home" ? "index.html" : `${id}/index.html`, href: id === "home" ? "" : `${id}/`, title: p.title, nav: p.nav, description: p.description || (id === "home" ? config.seo.description : ""), blocks, overlay });
  }
  if (!pages.length) warnings.push("Every page is switched off, so the site would be empty.");
  const extra: ExtraPage[] = [];
  for (const e of extensions) for (const pg of guard(e.id, "pages", () => e.pages?.(ctxFor(e.id)) ?? [], [] as ExtraPage[])) if (/^[a-z0-9-]{1,40}$/.test(pg.slug)) extra.push(pg);
  for (const pg of extra) {
    const at = pg.after ? pages.findIndex((p) => p.id === pg.after) : -1;
    const out: PageOut = { id: `x-${pg.slug}`, path: `${pg.slug}/index.html`, href: `${pg.slug}/`, title: pg.title, nav: pg.nav ?? null, description: pg.description ?? "", blocks: pg.html, overlay: false };
    pages.splice(at >= 0 ? at + 1 : pages.length, 0, out);
  }

  // ---- stylesheet and script (content-hashed names, so a republish never serves a stale copy)
  const th = config.theme;
  const heading_ = fontById(th.headingFont);
  const body_ = fontById(th.bodyFont);
  const fonts = fontAssets([th.headingFont, th.bodyFont]);
  const extCss = extensions.map((e) => guard(e.id, "css", () => e.css?.(ctxFor(e.id)) ?? "", "")).join("\n");
  const vars = `:root{--bg:${th.bg};--text:${th.text};--muted:${th.muted};--accent:${th.accent};--font-h:${heading_.stack};--font-b:${body_.stack};--h-scale:${HEADING_SCALE[th.headingSize]};--radius:${RADIUS[th.corners]}}\n`;
  const css = `${fonts.css}${vars}${BASE_CSS}.blk:not(.blk-hero) h1{font-size:calc(clamp(1.9rem,4vw,3rem)*var(--h-scale))}\n${template.css}\n${extCss}`;
  const cssName = `assets/site-${hash8(css)}.css`;
  const jsName = `assets/site-${hash8(SITE_JS)}.js`;

  const logoFile = !!input.logo && config.useLogo;
  const absolute = (p: string) => (config.siteUrl ? `${config.siteUrl}/${p}` : "");

  const layout = (page: PageOut, base: string, opts: { noindex?: boolean } = {}): string => {
    const bodyHtml = page.blocks.replaceAll("__BASE__", base);
    const menu = pages
      .filter((p) => p.nav)
      .map((p) => `<a href="${base}${p.href}"${p.id === page.id ? ' aria-current="page"' : ""}>${esc(p.nav!)}</a>`)
      .join("");
    const brand = logoFile ? `<img src="${base}assets/logo.png" alt="${esc(config.name)}">` : esc(config.name);
    const title = page.id === "home" || !page.title ? [config.name, config.tagline].filter(Boolean).join(" | ") : `${page.title} | ${config.name}`;
    const desc = page.description || config.seo.description;
    const url = absolute(page.href);
    const ogImage = input.share ? absolute(input.share.name) : "";
    const headExtra = extensions.map((e) => guard(e.id, "head", () => e.head?.(ctxFor(e.id), { path: page.path, title, description: desc }) ?? "", "")).join("\n");
    const bodyEnd = extensions.map((e) => guard(e.id, "bodyEnd", () => e.bodyEnd?.(ctxFor(e.id)) ?? "", "")).join("\n");
    const header = page.overlay ? "overlay" : template.header === "overlay" ? "split" : template.header;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ""}
${opts.noindex ? '<meta name="robots" content="noindex">' : ""}${url && !opts.noindex ? `<link rel="canonical" href="${esc(url)}">` : ""}
<meta name="theme-color" content="${esc(th.bg)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(config.name)}">
<meta property="og:title" content="${esc(title)}">
${desc ? `<meta property="og:description" content="${esc(desc)}">` : ""}
${url ? `<meta property="og:url" content="${esc(url)}">` : ""}
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}"><meta name="twitter:card" content="summary_large_image">` : ""}
${logoFile ? `<link rel="icon" href="${base}assets/favicon.png">` : ""}
<link rel="stylesheet" href="${base}${cssName}">
${headExtra}
</head>
<body class="t-${esc(template.id)}" data-header="${header}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap"><a class="brand" href="${base || "./"}">${brand}</a><nav class="menu" aria-label="Main">${menu}</nav></div></header>
<main id="main">
${bodyHtml}
</main>
<footer class="site-footer"><div class="wrap"><span>${esc(config.footer.text)}</span><span>${config.contact.links.map((l) => `<a href="${esc(l.url)}" rel="noopener me">${esc(l.label)}</a>`).join(" · ")}</span></div></footer>
<script src="${base}${jsName}" defer></script>
${bodyEnd}
</body>
</html>
`;
  };

  const files: SiteFile[] = [];
  for (const p of pages) files.push({ path: p.path, text: layout(p, p.path === "index.html" ? "" : "../") });
  const notFound: PageOut = { id: "404", path: "404.html", href: "", title: "Page not found", nav: null, description: "", overlay: false, blocks: `<section class="blk center"><div class="wrap"><h1>Page not found</h1><p class="lead">That page doesn't exist. <a href="/">Back to the home page</a>.</p></div></section>` };
  files.push({ path: "404.html", text: layout(notFound, "/", { noindex: true }) });
  files.push({ path: cssName, text: css }, { path: jsName, text: SITE_JS });
  for (const f of fonts.files) files.push({ path: `assets/${f.name}`, file: f.file });
  const seen = new Set<string>();
  for (const img of input.images.values()) for (const f of img.files) if (!seen.has(f.name)) (seen.add(f.name), files.push({ path: f.name, file: f.file }));
  if (input.share) files.push({ path: input.share.name, file: input.share.file });
  if (input.logo && logoFile) files.push({ path: "assets/logo.png", bytes: input.logo.png }, { path: "assets/favicon.png", bytes: input.logo.icon });
  for (const e of extensions) for (const f of guard(e.id, "files", () => e.files?.(ctxFor(e.id)) ?? [], [] as Array<{ path: string; data: string }>)) if (/^[\w./-]{1,100}$/.test(f.path) && !f.path.includes("..") && !files.some((x) => x.path === f.path)) files.push({ path: f.path, text: f.data });

  files.push({
    path: "robots.txt",
    text: `User-agent: *\nAllow: /\n${config.siteUrl ? `Sitemap: ${config.siteUrl}/sitemap.xml\n` : ""}`,
  });
  if (config.siteUrl) {
    files.push({ path: "sitemap.xml", text: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `<url><loc>${esc(absolute(p.href))}</loc></url>`).join("\n")}\n</urlset>\n` });
  } else {
    warnings.push("Add your website address under Details to get a sitemap and share previews. It is optional.");
  }
  files.push({
    path: "_headers",
    text: `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n/images/*\n  Cache-Control: public, max-age=31536000, immutable\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`,
  });

  return { files, warnings: [...new Set(warnings)], template };
}
