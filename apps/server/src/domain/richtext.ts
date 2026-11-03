import sanitizeHtml from "sanitize-html";

/**
 * Formatted text from the editors is stored as a small, fixed set of HTML. Everything that comes in is
 * cleaned here, and everything shown to a client is cleaned again, so no script or odd markup ever reaches a page.
 * Older text written before the editors existed is plain text, and `isHtml` tells the two apart.
 */
const BLOCK_START = /^\s*<(p|h[1-6]|ul|ol|blockquote|hr|div)\b/i;
export const isHtml = (s: string) => BLOCK_START.test(s);

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ALIGN = { "text-align": [/^(left|center|right|justify)$/] };

export function sanitizeRich(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "u", "s", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "hr", "a"],
    allowedAttributes: { a: ["href", "target", "rel"], p: ["style"], h2: ["style"], h3: ["style"], h4: ["style"], li: ["style"], blockquote: ["style"] },
    allowedStyles: { "*": ALIGN },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    // Browsers produce these; fold them into the tags we keep.
    transformTags: {
      b: "strong",
      i: "em",
      h1: "h2",
      h5: "h4",
      h6: "h4",
      div: "p",
      strike: "s",
      a: (_tag, attribs) => ({ tagName: "a", attribs: { href: attribs.href ?? "", target: "_blank", rel: "noopener noreferrer" } }),
    },
    exclusiveFilter: (f) => f.tag === "a" && !f.attribs.href,
  }).trim();
}

/** Plain text with the same words, for search, previews, emails and PDFs that only draw text. */
export function htmlToText(html: string): string {
  return blocks(html).map((b) => (b.kind === "hr" ? "-----" : b.text)).join("\n\n");
}

export interface Block {
  kind: "h" | "p" | "li" | "quote" | "hr";
  text: string;
  /** For a list item: its marker, like "•" or "3.". */
  marker?: string;
  level?: number;
}

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/** Walks cleaned HTML into blocks. Safe because the input has already been through `sanitizeRich`. */
export function blocks(html: string): Block[] {
  const out: Block[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) {
      cur.text = decode(cur.text).replace(/[ \t]+\n/g, "\n").trim();
      if (cur.text) out.push(cur);
      cur = null;
    }
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      if (!cur) cur = { kind: "p", text: "" };
      cur.text += m[3];
      continue;
    }
    const close = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (tag === "br") {
      if (cur) cur.text += "\n";
    } else if (tag === "hr") {
      flush();
      out.push({ kind: "hr", text: "" });
    } else if (tag === "ul" || tag === "ol") {
      flush();
      if (close) lists.pop();
      else lists.push({ ordered: tag === "ol", n: 0 });
    } else if (["p", "h2", "h3", "h4", "blockquote", "li"].includes(tag)) {
      flush();
      if (close) continue;
      if (tag === "li") {
        const l = lists[lists.length - 1];
        if (l) l.n += 1;
        cur = { kind: "li", text: "", marker: l?.ordered ? `${l.n}.` : "•", level: lists.length };
      } else cur = { kind: tag === "p" ? "p" : tag === "blockquote" ? "quote" : "h", text: "", level: tag === "h2" ? 2 : tag === "h3" ? 3 : 4 };
    }
  }
  flush();
  return out;
}

/** Wording on its way in: plain text keeps its lines, formatted text is cleaned down to the allowed markup. Markup with no words in it counts as empty. */
export function cleanRich(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!isHtml(t)) return t;
  const out = sanitizeRich(t);
  return htmlToText(out) || /<hr/i.test(out) ? out : "";
}

/** The same cleaning for text on its way out to a page. */
export const safeRich = (text: string | null | undefined): string => (text && isHtml(text) ? sanitizeRich(text) : (text ?? ""));
