import { registerSiteTemplate, type SiteTemplate } from "./registry.js";

/** The three templates every install has. */
export const FREE_TEMPLATES: SiteTemplate[] = [
  {
    id: "editorial",
    name: "Editorial",
    description: "Warm paper, elegant serif headings and a centered masthead. Made for weddings, families and portraits.",
    header: "centered",
    gallery: "masonry",
    theme: { bg: "#faf7f2", text: "#201d19", muted: "#6c655c", accent: "#8c5a3b", headingFont: "cormorant", bodyFont: "dm-sans", headingSize: "m", corners: "square" },
    css: `
.site-header .wrap{padding-top:34px;padding-bottom:26px;gap:14px}
.site-header{border-bottom:1px solid var(--line)}
.brand{font-size:2.1rem;font-style:italic}
.menu{gap:clamp(18px,3vw,40px)}.menu a{font-size:.8rem;letter-spacing:.2em;text-transform:uppercase}
h1,h2{font-weight:500}
.blk-hero .wrap{text-align:center}.blk-hero .sub{margin-left:auto;margin-right:auto}
.blk>.wrap>h2{text-align:center}
.gallery{margin-top:2em}
.btn{border-radius:0;letter-spacing:.16em;text-transform:uppercase;font-size:.78rem;font-weight:500;padding:1.1em 2.2em}
.card{border-radius:0;background:transparent}
.blk-cta{background:color-mix(in srgb,var(--accent) 9%,var(--bg))}
`,
  },
  {
    id: "studio",
    name: "Studio",
    description: "Dark and cinematic with a full-bleed hero and a tight square grid. Works well for events, sports and commercial work.",
    header: "split",
    gallery: "grid",
    theme: { bg: "#111111", text: "#f1eee8", muted: "#a29d94", accent: "#e3b66a", headingFont: "montserrat", bodyFont: "inter", headingSize: "m", corners: "soft" },
    css: `
:root{--accent-ink:#17120a}
.site-header{background:linear-gradient(#111,#11111100)}
.brand{font-size:1.1rem;font-weight:700;letter-spacing:.28em;text-transform:uppercase}
.menu a{font-size:.75rem;letter-spacing:.18em;text-transform:uppercase}
h1,h2,h3{font-weight:700;letter-spacing:.01em;text-transform:uppercase}
h1{font-size:calc(clamp(2rem,5vw,3.8rem)*var(--h-scale))}
h2{font-size:calc(clamp(1.3rem,2.6vw,1.9rem)*var(--h-scale))}
.price{font-weight:700}
.gallery.grid{gap:4px}.gallery a{border-radius:0}
.btn{border-radius:2px;text-transform:uppercase;letter-spacing:.16em;font-size:.75rem}
.blk-cta{background:#1a1a1a}
.card{background:#181818}
`,
  },
  {
    id: "clean",
    name: "Clean",
    description: "Bright, airy and modern. The header floats over a big opening photo and photos sit in neat justified rows.",
    header: "overlay",
    gallery: "rows",
    theme: { bg: "#ffffff", text: "#16181d", muted: "#656b76", accent: "#1f4fd6", headingFont: "inter", bodyFont: "inter", headingSize: "m", corners: "round" },
    css: `
h1,h2{font-weight:700;letter-spacing:-.03em}
.brand{font-weight:700;font-size:1.25rem;letter-spacing:-.02em}
.menu a{font-size:.9rem;font-weight:500}
.blk-hero.h-tall{min-height:86svh}
.gallery a{border-radius:calc(var(--radius)*1.5)}
.card{background:#f5f6f8;border:0}
.blk-cta{background:#f5f6f8}
`,
  },
];

export function registerFreeTemplates(): void {
  for (const t of FREE_TEMPLATES) registerSiteTemplate(t);
}
