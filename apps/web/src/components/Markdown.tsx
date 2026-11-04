import type { ReactNode } from "react";

/**
 * A small, safe markdown renderer for guides that ship with an extension. It builds React elements only (never raw
 * HTML), so nothing in the text can run script. Supports headings, paragraphs, bullet and numbered lists, tables,
 * block quotes, fenced code, bold, italic, inline code, links and images.
 * Links must be https, http, mailto or start with "/". Images must be inline png, jpeg or webp data.
 */
const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?!\/))/i;
const SAFE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}${i++}`;
    if (m[2] !== undefined) {
      if (SAFE_IMAGE.test(m[2])) out.push(<img key={k} className="guide-img" src={m[2]} alt={m[1]} loading="lazy" />);
      else out.push(m[1]);
    } else if (m[4] !== undefined) {
      out.push(
        SAFE_LINK.test(m[4]) ? (
          <a key={k} href={m[4]} target={m[4].startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
            {inline(m[3]!, k)}
          </a>
        ) : (
          m[3]
        ),
      );
    } else if (m[5] !== undefined) out.push(<code key={k}>{m[5]}</code>);
    else if (m[6] !== undefined) out.push(<strong key={k}>{inline(m[6], k)}</strong>);
    else out.push(<em key={k}>{inline(m[7]!, k)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push(<pre key={key}><code>{body.join("\n")}</code></pre>);
    } else if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const text = line.replace(/^#+\s*/, "");
      const Tag = (`h${Math.min(level + 1, 4)}`) as "h2" | "h3" | "h4";
      out.push(<Tag key={key}>{inline(text, key)}</Tag>);
      i++;
    } else if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key} className="table-scroll">
          <table className="table">
            <thead><tr>{head.map((h, c) => <th key={c}>{inline(h, `${key}h${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, c) => <td key={c}>{inline(r[c] ?? "", `${key}r${ri}c${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      out.push(<Tag key={key}>{items.map((t, k) => <li key={k}>{inline(t, `${key}i${k}`)}</li>)}</Tag>);
    } else if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(<blockquote key={key}>{inline(body.join(" "), key)}</blockquote>);
    } else {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i]!)) body.push(lines[i++]!);
      out.push(<p key={key}>{inline(body.join(" "), key)}</p>);
    }
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  return <div className="rich guide">{parseBlocks(source)}</div>;
}
