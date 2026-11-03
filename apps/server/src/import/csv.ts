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

const WRAPPER_KEYS = ["data", "items", "results", "records", "rows", "clients", "contacts", "customers", "people", "shoots", "projects", "invoices", "orders", "payments"];
const MAX_DEPTH = 4;

type Flat = Record<string, string>;

function scalar(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/**
 * Turns one JSON record into flat columns. Nested objects become dotted names ("name.first"), a list of
 * plain values is joined with "; ", and a list of objects becomes numbered columns ("emails.0.value").
 */
function flatten(value: unknown, prefix: string, out: Flat, depth: number): void {
  if (Array.isArray(value)) {
    if (value.every((v) => v == null || typeof v !== "object")) {
      out[prefix] = value.map(scalar).filter(Boolean).join("; ");
      return;
    }
    value.slice(0, 10).forEach((v, i) => flatten(v, `${prefix}.${i}`, out, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      out[prefix] = JSON.stringify(value);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length && prefix) out[prefix] = "";
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    return;
  }
  out[prefix] = scalar(value);
}

/** Finds the list of records: the file itself, a list under a common key such as "clients", or one record. */
function recordList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of WRAPPER_KEYS) if (Array.isArray(obj[k])) return obj[k] as unknown[];
    const lists = Object.values(obj).filter((v): v is unknown[] => Array.isArray(v) && v.some((x) => x && typeof x === "object"));
    if (lists.length === 1) return lists[0]!;
    if (!lists.length && Object.values(obj).some((v) => v != null && typeof v !== "object")) return [obj];
    if (lists.length > 1) throw new Error("That JSON file holds several lists. Split it so each file has one list of records.");
  }
  throw new Error("The JSON file should be a list of records.");
}

function parseJsonText(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (err) {
    // One record per line (JSON Lines) is common for exports.
    const lines = input.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1) {
      try {
        return lines.map((l) => JSON.parse(l));
      } catch {
        /* fall through to the clear error below */
      }
    }
    throw new Error(`That JSON file couldn't be read${err instanceof SyntaxError ? `: ${err.message.replace(/^JSON\.parse: /, "")}` : "."}`);
  }
}

export function parseJson(input: string): Table {
  const list = recordList(parseJsonText(input.replace(/^\uFEFF/, "")));
  if (list.length > MAX_ROWS) throw new Error(`That file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  const headers: string[] = [];
  const seen = new Set<string>();
  const rows = list.map((item) => {
    const out: Flat = {};
    if (item && typeof item === "object" && !Array.isArray(item)) flatten(item, "", out, 0);
    else out.value = scalar(item);
    for (const k of Object.keys(out)) if (!seen.has(k)) (seen.add(k), headers.push(k));
    return out;
  });
  // Every row gets every column, so a record that leaves a field out reads as blank.
  return { headers, rows: rows.map((r) => Object.fromEntries(headers.map((h) => [h, r[h] ?? ""]))) };
}

export function parseTable(input: string): Table {
  const t = input.trimStart();
  return t.startsWith("[") || t.startsWith("{") ? parseJson(t) : parseCsv(input);
}
