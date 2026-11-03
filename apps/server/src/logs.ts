import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

/** Private links carry a 32-character token. Logs get shared when asking for help, so tokens never reach the file. */
const TOKEN = /(\/)[A-Za-z0-9_-]{32}(?=[/?"\s\\]|$)/g;
export const redact = (line: string) => line.replace(TOKEN, "$1[token]");

/** Page files and this viewer's own polling would bury everything else, so they stay out of the saved file. */
const NOISE = /"url":"\/(assets\/|favicon|api\/studio\/logs)/;

/**
 * The app's own log, kept as a size-capped file next to the database (5 MB, three files) as well as on standard output,
 * so the owner can read it from Settings without opening a terminal.
 */
export function createLogStream(dir: string, file = "openportrait.log", out: NodeJS.WritableStream | null = process.stdout): Writable {
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, file);
  let size = fs.existsSync(main) ? fs.statSync(main).size : 0;
  const rotate = () => {
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? main : `${main}.${i - 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${main}.${i}`);
    }
    size = 0;
  };
  return new Writable({
    write(chunk: Buffer, _enc, done) {
      try {
        out?.write(chunk);
        const clean = redact(chunk.toString("utf8"));
        if (NOISE.test(clean)) return done();
        if (size + clean.length > MAX_BYTES) rotate();
        fs.appendFileSync(main, clean);
        size += clean.length;
      } catch {
        /* a full disk must never take the app down; standard output still has the line */
      }
      done();
    },
  });
}

export interface LogEntry {
  time: number;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  detail: string;
  raw: string;
}

const LEVELS: Record<number, LogEntry["level"]> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
export const LEVEL_RANK: Record<LogEntry["level"], number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** One JSON log line as something readable: what happened, and for a request, which one and how it went. */
export function parseLine(line: string): LogEntry | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line.trim() ? { time: 0, level: "info", message: line.trim().slice(0, 400), detail: "", raw: line } : null;
  }
  const req = j.req as { method?: string; url?: string } | undefined;
  const res = j.res as { statusCode?: number } | undefined;
  const err = j.err as { message?: string; type?: string } | undefined;
  const bits = [req ? `${req.method ?? ""} ${req.url ?? ""}`.trim() : "", res?.statusCode ? `→ ${res.statusCode}` : "", typeof j.responseTime === "number" ? `${Math.round(j.responseTime)} ms` : "", err?.message ?? ""].filter(Boolean);
  return { time: typeof j.time === "number" ? j.time : 0, level: LEVELS[Number(j.level)] ?? "info", message: String(j.msg ?? err?.message ?? ""), detail: bits.join("  "), raw: line };
}

/** The newest entries first, from the end of the files, filtered. Reads at most the last ~2 MB so a busy log stays quick. */
export function readLog(dir: string, opts: { level?: LogEntry["level"]; q?: string; limit?: number; file?: string } = {}): { entries: LogEntry[]; truncated: boolean } {
  const main = path.join(dir, opts.file ?? "openportrait.log");
  const limit = Math.min(opts.limit ?? 300, 1000);
  const min = LEVEL_RANK[opts.level ?? "trace"];
  const q = opts.q?.trim().toLowerCase();
  const files = [main, `${main}.1`, `${main}.2`].filter((f) => fs.existsSync(f));
  const out: LogEntry[] = [];
  let budget = 2 * 1024 * 1024;
  let truncated = false;
  for (const f of files) {
    const stat = fs.statSync(f);
    const take = Math.min(stat.size, budget);
    if (take < stat.size) truncated = true;
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, stat.size - take);
    fs.closeSync(fd);
    budget -= take;
    const lines = buf.toString("utf8").split("\n");
    if (take < stat.size) lines.shift(); // the first line was cut in half
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = parseLine(lines[i]!);
      if (!e || LEVEL_RANK[e.level] < min) continue;
      if (q && !`${e.message} ${e.detail}`.toLowerCase().includes(q) && !e.raw.toLowerCase().includes(q)) continue;
      out.push(e);
      if (out.length >= limit) return { entries: out, truncated: true };
    }
    if (budget <= 0) break;
  }
  return { entries: out, truncated };
}

/** Every log file joined oldest to newest, for the download. */
export function logFiles(dir: string, file = "openportrait.log"): string[] {
  const main = path.join(dir, file);
  return [`${main}.2`, `${main}.1`, main].filter((f) => fs.existsSync(f));
}
