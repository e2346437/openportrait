import { dateParts } from "./folders.js";

const DAY = 86_400_000;

/** `YYYY-MM-DD` of a moment as seen in a time zone. */
export const ymdIn = (ms: number, tz: string): string => dateParts(new Date(ms), tz).date;

/** Midnight at the start of `ymd` in `tz`, as epoch ms. Handles daylight-saving days. */
export function startOfDay(ymd: string, tz: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (t: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
    const g = (type: string) => Number(p.find((x) => x.type === type)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

const utc = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

export const addDays = (ymd: string, n: number): string => new Date(utc(ymd) + n * DAY).toISOString().slice(0, 10);
/** 0 = Sunday. */
export const weekdayOf = (ymd: string): number => new Date(utc(ymd)).getUTCDay();
export const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s)) && new Date(utc(s)).toISOString().slice(0, 10) === s;

/** A wall-clock time ("09:30") on a day, in a zone. */
export function atTime(ymd: string, hhmm: string, tz: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  // Built from midnight so days with a clock change still land on the right wall time.
  return startOfDay(ymd, tz) + (h * 60 + m) * 60_000 + wallShift(ymd, h, m, tz);
}

function wallShift(ymd: string, h: number, m: number, tz: string): number {
  const base = startOfDay(ymd, tz) + (h * 60 + m) * 60_000;
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(base));
  const gh = Number(p.find((x) => x.type === "hour")?.value);
  const gm = Number(p.find((x) => x.type === "minute")?.value);
  return ((h * 60 + m) - (gh * 60 + gm)) * 60_000;
}
