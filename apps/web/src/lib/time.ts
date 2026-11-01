/** Dates and times are shown, and typed, in the studio's time zone, whatever zone the browser is in. */

function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** "2026-11-14T15:30" typed in the studio's zone, as a UTC timestamp. */
export function zonedToMs(local: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone); // second pass settles times near a daylight-saving change
}

/** A UTC timestamp as "2026-11-14T15:30" in the studio's zone, for a datetime-local input. */
export function msToZoned(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function formatDate(ms: number, timeZone: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" }): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(ms));
}

export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

export function formatDateTime(ms: number, timeZone: string): string {
  return `${formatDate(ms, timeZone)} at ${formatTime(ms, timeZone)}`;
}

/** "3 days ago", "in 2 weeks", "just now". */
export function relative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000_000], ["month", 2_592_000_000], ["week", 604_800_000], ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
  for (const [unit, size] of units) if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  return "just now";
}

/** Any timestamp the API returns, as epoch milliseconds. */
export function ms(ts: string | number): number {
  return typeof ts === "number" ? ts : new Date(ts).getTime();
}
