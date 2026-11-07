import { describe, expect, it } from "vitest";
import { cleanRich, safeRich, sanitizeRich } from "../../src/domain/richtext.js";
import { control } from "./harness.js";

/**
 * SEC-017: formatted text (notes, contracts, quotes, questionnaires, inquiries, website copy) is cleaned
 * by `sanitizeRich` on the way in and again on the way out, then rendered as HTML. These payloads are
 * modelled on published sanitize-html bypasses and common XSS vectors. Every cleaning path must strip them.
 */

const payloads: Record<string, string> = {
  "textarea solidus-close mutation (GHSA-jxwj-j7wr-gfrw)": `<p>a</p><textarea/><img src=x onerror=alert(1)></textarea/><img src=x onerror=alert(2)>`,
  "textarea solidus-close, script and link": `<p><textarea></textarea/><script>alert(1)</script><a href="javascript:alert(1)">x</a></textarea></p>`,
  "noscript implied close (GHSA-x3q4-9hxx-gx8m)": `<p>x</p><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
  "noscript around style": `<p><noscript><style></noscript><img src=x onerror=alert(1)></style></noscript></p>`,
  "SVG SMIL animate URI (GHSA-g8qq-57p8-ggw5)": `<p>x</p><svg><a><animate attributeName=href values="javascript:alert(1)"/><text>y</text></a></svg>`,
  "meta refresh to javascript: (GHSA-cv27-6wvh-8x7j)": `<p>x</p><meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  "javascript: in action, formaction, poster (GHSA-vccv-cmxp-4j9h)": `<p>x</p><form action="javascript:alert(1)"><button formaction="javascript:alert(1)">b</button></form><video poster="javascript:alert(1)"></video>`,
  "javascript: links: plain, mixed case, entity-encoded, leading space": `<p><a href="javascript:alert(1)">x</a><a href="JaVaScRiPt:alert(1)">y</a><a href="&#106;avascript:alert(1)">z</a><a href=" javascript:alert(1)">w</a></p>`,
  "data: URL link": `<p><a href="data:text/html,<script>alert(1)</script>">x</a></p>`,
  "javascript: inside an allowed style": `<p style="background:url(javascript:alert(1));text-align:center">x</p>`,
  "event handlers on allowed tags": `<p onclick="alert(1)">x</p><a href="https://ok.example" onmouseover="alert(1)">y</a>`,
  "script inside an allowed tag": `<p><script>alert(1)</script>hi</p>`,
  "iframe": `<p>x</p><iframe src="https://evil.example"></iframe>`,
};

/** Anything that could run script, load a resource, or navigate on its own. */
const dangerous = /<\s*(script|img|svg|iframe|meta|form|button|video|audio|object|embed|style|noscript|textarea|animate|link|base|input)\b|\bon[a-z]+\s*=|\b(javascript|data|vbscript):/i;

const paths: Array<[string, (s: string) => string]> = [
  ["sanitizeRich", sanitizeRich],
  ["cleanRich (stored text)", cleanRich],
  ["safeRich (shown to clients)", safeRich],
  ["sanitizeRich twice", (s) => sanitizeRich(sanitizeRich(s))],
];

describe("SEC-017 rich-text cleaning blocks script and active content", () => {
  for (const [name, payload] of Object.entries(payloads)) {
    control("SEC-017", name, () => {
      for (const [path, clean] of paths) expect(clean(payload), path).not.toMatch(dangerous);
    });
  }
});

describe("SEC-017b rich-text cleaning keeps ordinary formatting", () => {
  // Guards against a "fix" that passes SEC-017 by stripping everything.
  it("keeps the allowed tags, alignment and safe links", () => {
    const input = `<h2 style="text-align:center">Title</h2><p>Some <strong>bold</strong>, <em>italic</em>, <u>under</u> and <s>struck</s> text.<br>Next line</p><ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quote</blockquote><hr><p><a href="https://example.com">site</a> <a href="mailto:pat@example.com">mail</a></p>`;
    const out = sanitizeRich(input);
    for (const tag of ["<h2", "<strong>", "<em>", "<u>", "<s>", "<br />", "<ul>", "<ol>", "<li>", "<blockquote>", "<hr />"]) expect(out).toContain(tag);
    expect(out).toContain('style="text-align:center"');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="mailto:pat@example.com"');
  });

  it("opens links in a new tab without giving the new page a handle on ours", () => {
    expect(sanitizeRich(`<p><a href="https://example.com" target="_self" rel="opener">x</a></p>`)).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">');
  });

  it("drops a link with no address", () => {
    // Current behaviour removes the link's words too (exclusiveFilter drops the whole element).
    expect(sanitizeRich(`<p>see <a>here</a></p>`)).not.toContain("<a");
  });

  it("leaves plain text alone when shown to a client", () => {
    expect(safeRich("Line one\nLine two <not a tag>")).toBe("Line one\nLine two <not a tag>");
  });
});

describe("SEC-017c server and browser agree on what counts as formatted text", () => {
  // The server only cleans text it judges to be HTML; the browser only inserts as HTML what it judges to be HTML
  // (everything else is shown as plain text). If the two rules drifted, the browser could render markup the server
  // never cleaned.
  const samples = [
    "<p>x</p>", "  <p>x</p>", "\n<P>x</P>", "<div>x</div>", "<h1>x</h1>", "<h6>x</h6>", "<hr>", "<ul><li>x</li></ul>", "<ol>", "<blockquote>x",
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<svg onload=alert(1)>", "<pre>x</pre>", "<paragraph>", "<h7>x</h7>",
    "x <p>y</p>", "plain text", "", " ", " <p>x</p>", "﻿<p>x</p>", "<!-- c --><p>x</p>", "<P\nclass=a>", "<p/>", "<p\t>",
  ];
  control("SEC-017c", "the server's and the browser's isHtml give the same answer for every sample", async () => {
    const server = await import("../../src/domain/richtext.js");
    const web = await import("../../../web/src/lib/richtext.js");
    for (const s of samples) expect(web.isHtml(s), JSON.stringify(s)).toBe(server.isHtml(s));
  });
});
