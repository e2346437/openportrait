import { zonedToMs } from "./time.js";

/** Calendar days are `YYYY-MM-DD` strings in the studio's time zone, so nothing depends on the browser's zone. */
export type Ymd = string;

export function ymdOf(ms: number, tz: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export const dayStart = (ymd: Ymd, tz: string) => zonedToMs(`${ymd}T00:00`, tz);

const utc = (ymd: Ymd) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number): Ymd => new Date(ms).toISOString().slice(0, 10);

export const addDays = (ymd: Ymd, n: number): Ymd => fromUtc(utc(ymd) + n * 86_400_000);
export const weekdayOf = (ymd: Ymd) => new Date(utc(ymd)).getUTCDay();
export const startOfWeek = (ymd: Ymd, weekStart = 0): Ymd => addDays(ymd, -((weekdayOf(ymd) - weekStart + 7) % 7));
export const startOfMonth = (ymd: Ymd): Ymd => `${ymd.slice(0, 7)}-01`;
export const addMonths = (ymd: Ymd, n: number): Ymd => {
  const [y, m] = ymd.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
};
export const daysBetween = (a: Ymd, b: Ymd) => Math.round((utc(b) - utc(a)) / 86_400_000);

/** The weeks shown for a month: whole weeks, from the one holding the 1st to the one holding the last day. */
export function monthWeeks(anchor: Ymd, weekStart = 0): Ymd[][] {
  const first = startOfMonth(anchor);
  const next = addMonths(first, 1);
  const weeks: Ymd[][] = [];
  for (let d = startOfWeek(first, weekStart); d < next; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

export function formatDay(ymd: Ymd, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(utc(ymd)));
}

export type CalendarSource = "shoot" | "appointment" | "block" | "busy";

export interface CalendarItem {
  key: string;
  source: CalendarSource;
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location: string | null;
  shootId?: string;
  shootType?: string;
  status?: string;
  contactId?: string | null;
  contactName?: string | null;
  notes?: string | null;
}

/** The part of an item that falls on one day, in minutes from midnight (all-day items fill the day). */
export function onDay(item: CalendarItem, ymd: Ymd, tz: string): { start: number; end: number } | null {
  const s = dayStart(ymd, tz);
  const e = dayStart(addDays(ymd, 1), tz);
  if (item.endsAt <= s && !(item.startsAt === item.endsAt && item.startsAt >= s)) return null;
  if (item.startsAt >= e) return null;
  const clampMin = (t: number) => Math.round((Math.min(Math.max(t, s), e) - s) / 60_000);
  return { start: clampMin(item.startsAt), end: Math.max(clampMin(item.endsAt), clampMin(item.startsAt) + 15) };
}

export function itemsByDay(items: CalendarItem[], days: Ymd[], tz: string): Map<Ymd, CalendarItem[]> {
  const map = new Map<Ymd, CalendarItem[]>(days.map((d) => [d, []]));
  for (const item of items) for (const d of days) if (onDay(item, d, tz)) map.get(d)!.push(item);
  for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt);
  return map;
}

/** Side-by-side lanes for overlapping timed items in a day column. */
export function layoutLanes<T extends { start: number; end: number }>(entries: T[]): Array<T & { lane: number; lanes: number }> {
  const sorted = [...entries].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Array<T & { lane: number; lanes: number }> = [];
  let group: Array<T & { lane: number; lanes: number }> = [];
  let groupEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const g of group) g.lanes = lanes;
    out.push(...group);
    group = [];
  };
  const laneEnds: number[] = [];
  for (const e of sorted) {
    if (e.start >= groupEnd && group.length) {
      flush();
      laneEnds.length = 0;
    }
    let lane = laneEnds.findIndex((end) => end <= e.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = e.end;
    group.push({ ...e, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, e.end);
  }
  if (group.length) flush();
  return out;
}
