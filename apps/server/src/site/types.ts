/** Shapes for the studio website builder (docs/website.md). The config is plain JSON saved in the `site` table. */

export const PAGE_IDS = ["home", "portfolio", "about", "services", "contact"] as const;
export type PageId = (typeof PAGE_IDS)[number];

export type ButtonTarget = string; // "page:<id>" | "inquire" | "book" | an https:// or mailto: address, or "" for none

export type Block =
  | { id: string; type: "hero"; heading: string; subheading: string; photoId: string; buttonLabel: string; buttonTarget: ButtonTarget; height: "full" | "tall" | "short"; align: "left" | "center" }
  | { id: string; type: "text"; heading: string; body: string; align: "left" | "center" }
  | { id: string; type: "gallery"; heading: string; photoIds: string[]; layout: "auto" | "grid" | "masonry" | "rows"; columns: 2 | 3 | 4 }
  | { id: string; type: "imageText"; heading: string; body: string; photoId: string; side: "left" | "right" }
  | { id: string; type: "services"; heading: string; intro: string; items: Array<{ name: string; price: string; description: string }> }
  | { id: string; type: "testimonials"; heading: string; items: Array<{ quote: string; author: string }> }
  | { id: string; type: "contact"; heading: string; intro: string }
  | { id: string; type: "cta"; heading: string; body: string; buttonLabel: string; buttonTarget: ButtonTarget };

export type BlockType = Block["type"];
export const BLOCK_TYPES: BlockType[] = ["hero", "text", "gallery", "imageText", "services", "testimonials", "contact", "cta"];

export interface PageConfig {
  enabled: boolean;
  /** The page's heading in the browser tab and search results. */
  title: string;
  /** The label in the menu. */
  nav: string;
  description: string;
  blocks: Block[];
}

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

export interface PhotoNote {
  alt: string;
  caption: string;
}

export interface SiteConfig {
  version: 1;
  template: string;
  name: string;
  tagline: string;
  /** Where the site will live, such as https://example.com. Optional; only used for the sitemap and share previews. */
  siteUrl: string;
  /** Show the studio logo (Settings > Studio) in the header instead of the name. */
  useLogo: boolean;
  theme: Theme;
  contact: { email: string; phone: string; location: string; links: Array<{ label: string; url: string }> };
  seo: { description: string; sharePhotoId: string };
  footer: { text: string };
  pages: Record<PageId, PageConfig>;
  /** Alt text and captions for the photos the owner picked. Only photos named by a block are exported. */
  photos: Record<string, PhotoNote>;
  /** Settings owned by extensions, keyed `<extensionId>.<key>`. Opaque to the app. */
  extras: Record<string, unknown>;
}

/** A photo as the renderer needs it. `relPath` is under the galleries share; it is never written to the site. */
export interface PhotoSource {
  id: string;
  relPath: string;
  contentHash: string;
  width: number | null;
  height: number | null;
}
