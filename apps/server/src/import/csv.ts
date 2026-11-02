/** A small CSV reader (RFC 4180 quoting, BOM, comma / semicolon / tab) and a JSON-array reader. */
export interface Table {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export const MAX_ROWS = 20_000;

function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

export function parseCsv(input: string): Table {
  const text = input.replace(/^﻿/, "");
  const delim = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      records.push(row);
      row = [];
    } else field += ch;
    if (records.length > MAX_ROWS + 1) throw new Error(`That file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  }
  if (field !== "" || row.length) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

export function parseJson(input: string): Table {
  const data = JSON.parse(input) as unknown;
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data).find(Array.isArray) : null;
  if (!Array.isArray(list)) throw new Error("The JSON file should be a list of records.");
  if (list.length > MAX_ROWS) throw new Error(`That file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  const headers: string[] = [];
  const rows = list.map((item) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((item ?? {}) as Record<string, unknown>)) {
      if (!headers.includes(k)) headers.push(k);
      out[k] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).trim();
    }
    return out;
  });
  return { headers, rows };
}

export function parseTable(input: string): Table {
  const t = input.trimStart();
  return t.startsWith("[") || t.startsWith("{") ? parseJson(t) : parseCsv(input);
}
