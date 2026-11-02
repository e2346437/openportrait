import type { PageId, SiteConfig } from "./types.js";

/**
 * What a template is: a name, the look it starts with, and some CSS. The renderer writes the same clean markup for
 * every template; templates change how it looks, so adding one never touches the renderer.
 */
export interface SiteTemplate {
  id: string;
  name: string;
  description: string;
  /** Header arrangement: logo centered above the menu, logo left with the menu right, or laid over the first image. */
  header: "centered" | "split" | "overlay";
  /** How a gallery block lays out photos when its own layout is "auto". */
  gallery: "masonry" | "grid" | "rows";
  /** Colors and fonts the site takes when this template is chosen. */
  theme: SiteConfig["theme"];
  css: string;
  /** Marks templates that come from an extension (shown with a badge). */
  extra?: boolean;
}

/** One field an extension wants in the builder's "More" tab. Its value is saved in `config.extras["<extension>.<key>"]`. */
export interface OptionField {
  key: string;
  label: string;
  type: "text" | "textarea" | "toggle" | "list";
  hint?: string;
  /** For lists: the columns of each row. Row values are strings. */
  columns?: Array<{ key: string; label: string; type: "text" | "textarea" | "date" }>;
  /** Placeholder or the default for text fields. */
  placeholder?: string;
}

export interface ExtraPage {
  /** URL folder, such as "journal" or "journal/first-post" (written to <slug>/index.html). Use `__BASE__` in links and image paths; it becomes the path back to the site root. */
  slug: string;
  title: string;
  description?: string;
  /** Menu label. Leave out to keep the page out of the menu. */
  nav?: string;
  /** Page body, already escaped HTML. */
  html: string;
  /** Where in the menu: after this core page (default: last). */
  after?: PageId;
}

export interface RenderContext {
  config: SiteConfig;
  /** Escapes text for HTML. */
  esc(s: string): string;
  /** Option value saved for this extension: `extras["<id>.<key>"]`. */
  option<T = unknown>(key: string): T | undefined;
}

/** A module that adds to what sites can do. All parts are optional. */
export interface SiteExtension {
  id: string;
  title: string;
  /** Fields shown in the builder's "More" tab. */
  options?: OptionField[];
  /** Extra CSS appended to the site's stylesheet. */
  css?(ctx: RenderContext): string;
  /** HTML added at the end of every page's head. */
  head?(ctx: RenderContext, page: { path: string; title: string; description: string }): string;
  /** HTML added before the closing body tag of every page. */
  bodyEnd?(ctx: RenderContext): string;
  /** More pages, written with the site's own header and footer. */
  pages?(ctx: RenderContext): ExtraPage[];
  /** More files (a feed, a verification file). Paths are relative to the site root. */
  files?(ctx: RenderContext): Array<{ path: string; data: string }>;
}

const templates = new Map<string, SiteTemplate>();
const extensions = new Map<string, SiteExtension>();

/** Adds or replaces a template. Extensions call this when they load (and only when they are allowed to). */
export function registerSiteTemplate(t: SiteTemplate): void {
  templates.set(t.id, t);
}
export function unregisterSiteTemplate(id: string): void {
  templates.delete(id);
}
export function registerSiteExtension(e: SiteExtension): void {
  extensions.set(e.id, e);
}
export function unregisterSiteExtension(id: string): void {
  extensions.delete(id);
}
export const siteTemplates = () => [...templates.values()];
export const siteTemplate = (id: string) => templates.get(id);
export const siteExtensions = () => [...extensions.values()];
