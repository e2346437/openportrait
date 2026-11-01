import { addDays, atTime, weekdayOf, ymdIn } from "../domain/time.js";

/** One recurring weekly window when the upload server is open. `days` use 0 = Sunday. An end before the start runs past midnight. */
export interface ScheduleWindow {
  days: number[];
  start: string;
  end: string;
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns a plain-language problem with the windows, or null when they're usable. */
export function scheduleProblem(windows: ScheduleWindow[]): string | null {
  if (windows.length > 14) return "Use at most 14 time windows.";
  for (const w of windows) {
    if (w.days.length === 0) return "Choose at least one day for each time window.";
    if (!w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return "Days must be Sunday to Saturday.";
    if (!HHMM.test(w.start) || !HHMM.test(w.end)) return "Enter times as hours and minutes, like 18:00.";
    if (w.start === w.end) return "A window's start and end can't be the same time.";
  }
  return null;
}

export interface Interval {
  start: number;
  end: number;
}

/** Every open interval from a day before `now` to a week after, merged and in order. */
export function intervals(windows: ScheduleWindow[], tz: string, now: number): Interval[] {
  const today = ymdIn(now, tz);
  const out: Interval[] = [];
  for (let offset = -1; offset <= 8; offset++) {
    const day = addDays(today, offset);
    const dow = weekdayOf(day);
    for (const w of windows) {
      if (!w.days.includes(dow)) continue;
      const start = atTime(day, w.start, tz);
      const end = w.end > w.start ? atTime(day, w.end, tz) : atTime(addDays(day, 1), w.end, tz);
      out.push({ start, end });
    }
  }
  out.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const i of out) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged;
}

export interface ScheduleState {
  open: boolean;
  /** When the current window ends, if one is open. */
  closesAt: number | null;
  /** When the next window starts, if any begins within the coming week. */
  nextOpenAt: number | null;
}

export function scheduleState(windows: ScheduleWindow[], tz: string, now: number): ScheduleState {
  const list = intervals(windows, tz, now);
  const current = list.find((i) => i.start <= now && now < i.end);
  const next = list.find((i) => i.start > now);
  return { open: Boolean(current), closesAt: current?.end ?? null, nextOpenAt: next?.start ?? null };
}
