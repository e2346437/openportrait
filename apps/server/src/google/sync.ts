import crypto from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { newId, type ServiceContext } from "../domain/context.js";
import { addDays, startOfDay, ymdIn } from "../domain/time.js";
import { GoogleAuthError, SyncTokenExpired, type GoogleApi, type GoogleEvent } from "./api.js";

const { calendarEntry, shootEvent, shoot, shootType, contact, googleCalendar, googleLink, busyBlock } = tables;

export const STUDIO_CALENDAR_NAME = "OpenPortrait";
const DAY = 86400000;
const PAST_DAYS = 30;
const FUTURE_DAYS = 400;

/** What is compared between OpenPortrait and Google. Only fields that can be edited on both sides. */
interface Shape {
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location: string;
}

const hashOf = (s: Shape) => crypto.createHash("sha1").update(JSON.stringify([s.summary, s.startsAt, s.endsAt, s.allDay, s.location])).digest("hex");

// ---- time zone helpers ----

export { startOfDay };
const ymdOf = ymdIn;

// ---- local <-> Google ----

interface LocalItem {
  type: "shoot_event" | "calendar_entry";
  id: string;
  shape: Shape;
  description: string | null;
}

function toGoogle(item: LocalItem, tz: string) {
  const s = item.shape;
  const base = { summary: s.summary, location: s.location || undefined, description: item.description ?? undefined };
  if (s.allDay) {
    // All-day items end at the start of the day after their last day, which is also how Google counts them.
    const start = ymdOf(s.startsAt, tz);
    const end = ymdOf(s.endsAt, tz);
    return { ...base, start: { date: start }, end: { date: end > start ? end : addDays(start, 1) } };
  }
  return { ...base, start: { dateTime: new Date(s.startsAt).toISOString(), timeZone: tz }, end: { dateTime: new Date(s.endsAt).toISOString(), timeZone: tz } };
}

function fromGoogle(e: GoogleEvent, tz: string): Shape | null {
  const s = e.start;
  const en = e.end;
  if (!s || !en) return null;
  if (s.date) {
    const startsAt = startOfDay(s.date, tz);
    const end = en.date && en.date > s.date ? en.date : addDays(s.date, 1);
    return { summary: e.summary ?? "", startsAt, endsAt: startOfDay(end, tz), allDay: true, location: e.location ?? "" };
  }
  if (!s.dateTime || !en.dateTime) return null;
  return { summary: e.summary ?? "", startsAt: Date.parse(s.dateTime), endsAt: Date.parse(en.dateTime), allDay: false, location: e.location ?? "" };
}

// ---- state in settings ----

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  needsReconnect: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

export function googleStatus(ctx: ServiceContext): GoogleStatus {
  const s = ctx.settings;
  return {
    configured: !!(s.get("google.clientId") && s.get("google.clientSecret")),
    connected: !!s.get("google.refreshToken"),
    email: s.get("google.email") ?? null,
    needsReconnect: !!s.get("google.needsReconnect"),
    lastSyncAt: s.get("google.lastSyncAt") ?? null,
    lastError: s.get("google.lastError") ?? null,
  };
}

// ---- the sync ----

export interface SyncResult {
  pushed: number;
  pulled: number;
  removed: number;
  busy: number;
}

/**
 * One full pass: read Google's changes first (so an edit made in Google wins over an unsynced local one),
 * then send local changes, then refresh busy times from the other calendars.
 *
 * Shoot times are the source of truth: a shoot time deleted in Google comes back on the next pass,
 * while an appointment or block deleted in Google is deleted here too.
 */
export async function syncGoogle(ctx: ServiceContext, api: GoogleApi, now = Date.now()): Promise<SyncResult> {
  const tz = ctx.settings.get("studio.timezone") ?? "UTC";
  const result: SyncResult = { pushed: 0, pulled: 0, removed: 0, busy: 0 };
  const studioId = await ensureStudioCalendar(ctx, api, tz);
  await pullStudio(ctx, api, studioId, tz, now, result);
  await pushLocal(ctx, api, studioId, tz, now, result);
  await pullBusy(ctx, api, tz, now, result);
  return result;
}

async function ensureStudioCalendar(ctx: ServiceContext, api: GoogleApi, tz: string): Promise<string> {
  const saved = ctx.settings.get("google.studioCalendarId");
  const calendars = await api.listCalendars();
  if (saved && calendars.some((c) => c.id === saved)) return saved;
  const existing = calendars.find((c) => c.name === STUDIO_CALENDAR_NAME && (c.accessRole === "owner" || c.accessRole === "writer"));
  const cal = existing ?? (await api.createCalendar(STUDIO_CALENDAR_NAME, tz));
  ctx.settings.set("google.studioCalendarId", cal.id);
  ctx.db.delete(googleCalendar).where(eq(googleCalendar.role, "studio")).run();
  ctx.db.insert(googleCalendar).values({ id: cal.id, name: cal.name, role: "studio" }).onConflictDoUpdate({ target: googleCalendar.id, set: { role: "studio", name: cal.name, syncToken: null } }).run();
  return cal.id;
}

/** Lists the account's calendars with whether each is used for busy times. */
export async function listChoices(ctx: ServiceContext, api: GoogleApi) {
  const studioId = ctx.settings.get("google.studioCalendarId");
  const chosen = new Set(ctx.db.select({ id: googleCalendar.id }).from(googleCalendar).where(eq(googleCalendar.role, "busy")).all().map((r) => r.id));
  return (await api.listCalendars()).filter((c) => c.id !== studioId).map((c) => ({ id: c.id, name: c.name, primary: c.primary, busy: chosen.has(c.id) }));
}

export function setBusyCalendars(ctx: ServiceContext, picks: Array<{ id: string; name: string }>) {
  const ids = picks.map((p) => p.id);
  ctx.db.transaction((tx) => {
    const gone = tx.select({ id: googleCalendar.id }).from(googleCalendar).where(ids.length ? and(eq(googleCalendar.role, "busy"), notInArray(googleCalendar.id, ids)) : eq(googleCalendar.role, "busy")).all();
    for (const g of gone) {
      tx.delete(busyBlock).where(eq(busyBlock.calendarId, g.id)).run();
      tx.delete(googleCalendar).where(eq(googleCalendar.id, g.id)).run();
    }
    for (const p of picks) {
      tx.insert(googleCalendar).values({ id: p.id, name: p.name, role: "busy" }).onConflictDoNothing().run();
    }
  });
}

/** Forget the connection and everything cached from Google. Events already in Google stay there. */
export function disconnectGoogle(ctx: ServiceContext) {
  for (const k of ["google.refreshToken", "google.email", "google.studioCalendarId", "google.needsReconnect", "google.lastSyncAt", "google.lastError"] as const) ctx.settings.delete(k);
  ctx.db.delete(googleLink).run();
  ctx.db.delete(googleCalendar).run();
  ctx.db.delete(busyBlock).run();
}

async function readEvents(api: GoogleApi, calendarId: string, syncToken: string | null, now: number, onReset: () => void) {
  const full = () => api.listEvents(calendarId, { timeMin: new Date(now - PAST_DAYS * DAY).toISOString(), timeMax: new Date(now + FUTURE_DAYS * DAY).toISOString() });
  if (!syncToken) return full();
  try {
    return await api.listEvents(calendarId, { syncToken });
  } catch (err) {
    if (!(err instanceof SyncTokenExpired)) throw err;
    onReset();
    return full();
  }
}

async function pullStudio(ctx: ServiceContext, api: GoogleApi, calendarId: string, tz: string, now: number, out: SyncResult) {
  const row = ctx.db.select().from(googleCalendar).where(eq(googleCalendar.id, calendarId)).get();
  const { events, nextSyncToken } = await readEvents(api, calendarId, row?.syncToken ?? null, now, () => undefined);
  for (const e of events) {
    const link = ctx.db.select().from(googleLink).where(and(eq(googleLink.calendarId, calendarId), eq(googleLink.googleEventId, e.id))).get();
    if (e.status === "cancelled") {
      if (!link) continue;
      if (link.itemType === "calendar_entry") {
        ctx.db.delete(calendarEntry).where(eq(calendarEntry.id, link.itemId)).run();
        out.removed++;
      }
      // A deleted shoot time is sent again by the push below, so only the link goes.
      ctx.db.delete(googleLink).where(eq(googleLink.id, link.id)).run();
      continue;
    }
    const shape = fromGoogle(e, tz);
    if (!shape) continue;
    const hash = hashOf(shape);
    if (link) {
      if (link.pushedHash === hash) {
        if (link.etag !== e.etag) ctx.db.update(googleLink).set({ etag: e.etag ?? null }).where(eq(googleLink.id, link.id)).run();
        continue;
      }
      applyGoogleChange(ctx, link.itemType, link.itemId, shape);
      // A shoot time's title comes from the shoot, so if Google's differs, clear the baseline and the push below puts ours back.
      const local = localShape(ctx, link.itemType, link.itemId);
      const same = local ? hashOf(local) === hash : true;
      ctx.db.update(googleLink).set({ etag: e.etag ?? null, pushedHash: same ? hash : null }).where(eq(googleLink.id, link.id)).run();
      out.pulled++;
    } else {
      const id = newId();
      ctx.db.insert(calendarEntry).values({ id, kind: "appointment", title: shape.summary || "(No title)", startsAt: new Date(shape.startsAt), endsAt: new Date(shape.endsAt), allDay: shape.allDay, location: shape.location || null }).run();
      ctx.db.insert(googleLink).values({ id: newId(), itemType: "calendar_entry", itemId: id, calendarId, googleEventId: e.id, etag: e.etag ?? null, pushedHash: hash }).run();
      out.pulled++;
    }
  }
  ctx.db.update(googleCalendar).set({ syncToken: nextSyncToken ?? null, syncedAt: new Date(now), lastError: null }).where(eq(googleCalendar.id, calendarId)).run();
}

function applyGoogleChange(ctx: ServiceContext, type: "shoot_event" | "calendar_entry", id: string, s: Shape) {
  if (type === "calendar_entry") {
    ctx.db.update(calendarEntry).set({ title: s.summary || "(No title)", startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), allDay: s.allDay, location: s.location || null }).where(eq(calendarEntry.id, id)).run();
  } else {
    ctx.db.update(shootEvent).set({ startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), allDay: s.allDay, location: s.location || null }).where(eq(shootEvent.id, id)).run();
  }
}

function localShape(ctx: ServiceContext, type: "shoot_event" | "calendar_entry", id: string): Shape | null {
  return loadItems(ctx, type === "shoot_event" ? { shootEventId: id } : { entryId: id })[0]?.shape ?? null;
}

function loadItems(ctx: ServiceContext, only?: { shootEventId?: string; entryId?: string }): LocalItem[] {
  const items: LocalItem[] = [];
  const publicUrl = (() => {
    try {
      return ctx.settings.get("internet.publicUrl") || ctx.config.appUrl || "";
    } catch {
      return "";
    }
  })();
  if (!only || only.shootEventId) {
    const rows = ctx.db
      .select({ e: shootEvent, subject: shoot.subject, shootId: shoot.id, status: shoot.status, type: shootType.name, first: contact.firstName, last: contact.lastName, company: contact.company })
      .from(shootEvent)
      .innerJoin(shoot, eq(shoot.id, shootEvent.shootId))
      .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
      .innerJoin(contact, eq(contact.id, shoot.primaryContactId))
      .where(only?.shootEventId ? eq(shootEvent.id, only.shootEventId) : undefined)
      .all();
    for (const r of rows) {
      if (r.status === "cancelled") continue;
      const client = `${r.first} ${r.last}`.trim() || r.company || "";
      items.push({
        type: "shoot_event",
        id: r.e.id,
        shape: { summary: r.e.title ? `${r.subject}: ${r.e.title}` : r.subject, startsAt: r.e.startsAt.getTime(), endsAt: r.e.endsAt.getTime(), allDay: r.e.allDay, location: r.e.location ?? "" },
        description: [`${r.type} shoot${client ? ` for ${client}` : ""}`, publicUrl ? `${publicUrl}/studio/shoots/${r.shootId}` : ""].filter(Boolean).join("\n"),
      });
    }
  }
  if (!only || only.entryId) {
    const rows = ctx.db.select().from(calendarEntry).where(only?.entryId ? eq(calendarEntry.id, only.entryId) : undefined).all();
    for (const e of rows) {
      items.push({ type: "calendar_entry", id: e.id, shape: { summary: e.title, startsAt: e.startsAt.getTime(), endsAt: e.endsAt.getTime(), allDay: e.allDay, location: e.location ?? "" }, description: e.notes });
    }
  }
  return items;
}

async function pushLocal(ctx: ServiceContext, api: GoogleApi, calendarId: string, tz: string, now: number, out: SyncResult) {
  const links = ctx.db.select().from(googleLink).where(eq(googleLink.calendarId, calendarId)).all();
  const byItem = new Map(links.map((l) => [`${l.itemType}:${l.itemId}`, l]));
  const items = loadItems(ctx);
  const alive = new Set(items.map((i) => `${i.type}:${i.id}`));

  // Remove from Google what no longer exists here (deleted items, cancelled shoots).
  for (const l of links) {
    if (alive.has(`${l.itemType}:${l.itemId}`)) continue;
    await api.deleteEvent(calendarId, l.googleEventId);
    ctx.db.delete(googleLink).where(eq(googleLink.id, l.id)).run();
    out.removed++;
  }

  const from = now - PAST_DAYS * DAY;
  const to = now + FUTURE_DAYS * DAY;
  for (const item of items) {
    const key = `${item.type}:${item.id}`;
    const link = byItem.get(key);
    // Old history is left alone unless it was already synced.
    if (!link && (item.shape.endsAt < from || item.shape.startsAt > to)) continue;
    const hash = hashOf(item.shape);
    if (link && link.pushedHash === hash) continue;
    const body = toGoogle(item, tz);
    if (link) {
      try {
        const e = await api.patchEvent(calendarId, link.googleEventId, body);
        ctx.db.update(googleLink).set({ etag: e.etag ?? null, pushedHash: hash }).where(eq(googleLink.id, link.id)).run();
        out.pushed++;
        continue;
      } catch (err) {
        if (!(err instanceof Error && "status" in err && ((err as { status: number }).status === 404 || (err as { status: number }).status === 410))) throw err;
        ctx.db.delete(googleLink).where(eq(googleLink.id, link.id)).run();
      }
    }
    const e = await api.insertEvent(calendarId, body);
    ctx.db.insert(googleLink).values({ id: newId(), itemType: item.type, itemId: item.id, calendarId, googleEventId: e.id, etag: e.etag ?? null, pushedHash: hash }).run();
    out.pushed++;
  }
}

async function pullBusy(ctx: ServiceContext, api: GoogleApi, tz: string, now: number, out: SyncResult) {
  const rows = ctx.db.select().from(googleCalendar).where(eq(googleCalendar.role, "busy")).all();
  for (const cal of rows) {
    try {
      const { events, nextSyncToken } = await readEvents(api, cal.id, cal.syncToken, now, () => ctx.db.delete(busyBlock).where(eq(busyBlock.calendarId, cal.id)).run());
      for (const e of events) {
        if (e.status === "cancelled" || e.transparency === "transparent") {
          ctx.db.delete(busyBlock).where(and(eq(busyBlock.calendarId, cal.id), eq(busyBlock.googleEventId, e.id))).run();
          continue;
        }
        const s = fromGoogle(e, tz);
        if (!s) continue;
        ctx.db
          .insert(busyBlock)
          .values({ calendarId: cal.id, googleEventId: e.id, startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), allDay: s.allDay })
          .onConflictDoUpdate({ target: [busyBlock.calendarId, busyBlock.googleEventId], set: { startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), allDay: s.allDay } })
          .run();
        out.busy++;
      }
      ctx.db.update(googleCalendar).set({ syncToken: nextSyncToken ?? null, syncedAt: new Date(now), lastError: null }).where(eq(googleCalendar.id, cal.id)).run();
    } catch (err) {
      if (err instanceof GoogleAuthError) throw err;
      ctx.db.update(googleCalendar).set({ lastError: err instanceof Error ? err.message : String(err) }).where(eq(googleCalendar.id, cal.id)).run();
    }
  }
}

