import type { Settings } from "../settings.js";

export type TemplateId = "galleryReady";

export interface Template {
  subject: string;
  body: string;
}

/** Merge fields every template can use, shown to the studio next to the editor. */
export const MERGE_FIELDS = ["client_name", "gallery_title", "gallery_link", "studio_name", "message"] as const;

export const DEFAULT_TEMPLATES: Record<TemplateId, Template> = {
  galleryReady: {
    subject: "Your photos from {{studio_name}} are ready",
    body: "Hi {{client_name}},\n\nYour gallery “{{gallery_title}}” is ready to view.\n\n{{message}}\n\nTake your time, tap the heart on the photos you love, and send your favorites back to us when you're done.",
  },
};

export function templateFor(settings: Settings, id: TemplateId): Template {
  const saved = settings.get(`email.template.${id}` as "email.template.galleryReady");
  return { ...DEFAULT_TEMPLATES[id], ...(saved ?? {}) };
}

/** Fills {{fields}}. Unknown fields become empty, and a line left empty by that is dropped. */
export function fill(text: string, values: Record<string, string>): string {
  return text
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => values[k] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain, branded email: studio name on top, the message, one clear button. The text part carries the link too. */
export function renderEmail(opts: { studioName: string; body: string; button?: { label: string; url: string }; logoUrl?: string | null; footer?: string }): { text: string; html: string } {
  const paragraphs = opts.body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const button = opts.button
    ? `<p style="margin:28px 0"><a href="${esc(opts.button.url)}" style="display:inline-block;background:#1b1a17;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600">${esc(opts.button.label)}</a></p><p style="margin:0 0 16px;font-size:13px;color:#6b665c;word-break:break-all">Or paste this link into your browser:<br>${esc(opts.button.url)}</p>`
    : "";
  const head = opts.logoUrl ? `<img src="${esc(opts.logoUrl)}" alt="${esc(opts.studioName)}" style="max-height:56px;max-width:220px">` : `<span style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;font-weight:700">${esc(opts.studioName)}</span>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Georgia,'Times New Roman',serif;color:#1b1a17"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf9;border-radius:14px;padding:32px 28px"><tr><td>${head}<div style="height:24px"></div><div style="font-size:16px">${paragraphs}${button}</div>${opts.footer ? `<p style="margin:24px 0 0;font-size:12.5px;color:#8a8478">${esc(opts.footer)}</p>` : ""}</td></tr></table></td></tr></table></body></html>`;
  const text = `${opts.body}${opts.button ? `\n\n${opts.button.label}: ${opts.button.url}` : ""}${opts.footer ? `\n\n${opts.footer}` : ""}`;
  return { text, html };
}
