/** Helpers for the formatted-text editors. The server cleans everything again on save; this keeps the editor tidy. */

const BLOCK_START = /^\s*<(p|h[1-6]|ul|ol|blockquote|hr|div)\b/i;
export const isHtml = (s: string) => BLOCK_START.test(s);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text written before the editors existed: a line starting "# " is a heading, other lines are paragraphs. */
export function toEditorHtml(text: string): string {
  if (!text.trim() || isHtml(text)) return text;
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => (l.startsWith("# ") ? `<h2>${esc(l.slice(2))}</h2>` : `<p>${esc(l)}</p>`))
    .join("");
}

/** One line of the words with no markup, for list previews. */
export function plainPreview(s: string, max = 110): string {
  const t = isHtml(s) ? s.replace(/<\/(p|h[1-6]|li|blockquote)>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : s.replace(/[#\n]+/g, " ");
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

const KEEP = new Set(["P", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "U", "S", "A", "BR", "BLOCKQUOTE", "HR"]);
const RENAME: Record<string, string> = { B: "STRONG", I: "EM", H1: "H2", H5: "H4", H6: "H4", DIV: "P", STRIKE: "S" };

/** Pasted formatting from Word, a web page or another document, reduced to the same small set the editor offers. */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    if (["SCRIPT", "STYLE", "META", "TITLE"].includes(el.tagName)) return "";
    const inner = Array.from(el.childNodes).map(walk).join("");
    const tag = RENAME[el.tagName] ?? el.tagName;
    if (!KEEP.has(tag)) return inner;
    const t = tag.toLowerCase();
    if (t === "br" || t === "hr") return `<${t}>`;
    if (t === "a") {
      const href = el.getAttribute("href") ?? "";
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${href.replace(/"/g, "&quot;")}">${inner}</a>` : inner;
    }
    return `<${t}>${inner}</${t}>`;
  };
  return Array.from(doc.body.childNodes).map(walk).join("");
}
