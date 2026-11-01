import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FOLDER_PATTERN = "{year}/{date} {type} - {subject}";
export const DEFAULT_RAW_SUBDIR = "Originals/RAW";
export const DEFAULT_DELIVERY_SUBDIR = "Gallery";

export const FOLDER_TOKENS = ["year", "month", "date", "type", "subject", "client", "location"] as const;
export type FolderToken = (typeof FOLDER_TOKENS)[number];
export type FolderValues = Partial<Record<FolderToken, string>>;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Makes one folder name safe for Windows, macOS and SMB shares. */
export function safeSegment(input: string): string {
  let s = input
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/[. ]+$/, "").replace(/^\.+/, "").trim();
  if (s.length > 120) s = s.slice(0, 120).trim().replace(/[. ]+$/, "");
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** Tidies what is left when a token was empty: doubled spaces, a dangling " - ", empty parentheses. */
function tidy(segment: string): string {
  return segment
    .replace(/\(\s*\)/g, "")
    .replace(/\s+-\s+(?=-|$)/g, "")
    .replace(/^\s*-\s+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Lists the tokens in a pattern that aren't known, so settings can reject typos like `{subjet}`. */
export function unknownTokens(pattern: string): string[] {
  return [...pattern.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? "").filter((t) => !(FOLDER_TOKENS as readonly string[]).includes(t));
}

/**
 * Renders the folder pattern into a relative path such as `2026/2026-11-14 Headshot - Jane Smith`.
 * `/` in the pattern separates folders; token values can never add folders of their own.
 * Returns null when nothing usable is left.
 */
export function renderFolder(pattern: string, values: FolderValues): string | null {
  const segments = pattern
    .split("/")
    .map((raw) => safeSegment(tidy(raw.replace(/\{([^{}]*)\}/g, (_m, token: string) => safeSegment(values[token as FolderToken] ?? "")))))
    .filter(Boolean);
  return segments.length ? segments.join("/") : null;
}

/** `YYYY-MM-DD`, `YYYY`, `MM` for a moment, as seen in the studio's time zone. */
export function dateParts(at: Date, timeZone: string): { year: string; month: string; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: get("year"), month: get("month"), date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** Subfolders are relative, and may not climb out of the shoot folder. */
export function cleanSubdir(input: string): string {
  return input
    .split(/[\\/]+/)
    .map((p) => safeSegment(p))
    .filter((p) => p && p !== "..")
    .join("/");
}

/** Adds ` (2)`, ` (3)` ... until `taken` says the folder is free. */
export function uniqueFolder(rel: string, taken: (candidate: string) => boolean): string {
  if (!taken(rel)) return rel;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${rel} (${n})`;
    if (!taken(candidate)) return candidate;
  }
  return `${rel} (${Date.now()})`;
}

/** Joins a stored relative path onto the share, refusing anything that would leave it. */
export function resolveInside(root: string, rel: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("Folder is outside the galleries share.");
  return full;
}

export interface CreatedFolder {
  path: string;
}

/** Creates the shoot folder and its subfolders. Throws a plain-language Error if the share isn't writable. */
export function createShootFolder(root: string, rel: string, subdirs: string[]): void {
  try {
    for (const sub of subdirs.length ? subdirs : [""]) {
      fs.mkdirSync(resolveInside(root, path.join(rel, sub)), { recursive: true });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error(`OpenPortrait isn't allowed to write to the galleries share. Check the container's PUID/PGID and the share's permissions.`);
    if (code === "EROFS") throw new Error("The galleries share is read-only.");
    if (code === "ENOSPC") throw new Error("The galleries share is full.");
    throw new Error(`The folder couldn't be created (${code ?? (err as Error).message}).`);
  }
}
