import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { tables } from "@openportrait/db";
import { buildApp } from "../src/app.js";
import * as calendar from "../src/domain/calendar.js";
import type { ServiceContext } from "../src/domain/context.js";
import { createContact } from "../src/domain/contacts.js";
import { addEvent, createShoot, updateEvent, updateShoot, removeEvent } from "../src/domain/shoots.js";
import { SyncTokenExpired, type GoogleApi, type GoogleCalendarInfo, type GoogleEvent } from "../src/google/api.js";
import { disconnectGoogle, setBusyCalendars, startOfDay, syncGoogle } from "../src/google/sync.js";

/** An in-memory Google Calendar. Edits made "in Google" bump the etag and are returned by the next incremental read. */
class FakeGoogle implements GoogleApi {
  calendars = new Map<string, { info: GoogleCalendarInfo; events: Map<string, GoogleEvent>; log: Array<{ at: number; id: string }> }>();
  seq = 0;
  clock = 0;
  calls: string[] = [];
  expireTokens = false;

  constructor() {
    this.add("primary", "Eric", "owner");
  }
  add(id: string, name: string, accessRole: string) {
    this.calendars.set(id, { info: { id, name, primary: id === "primary", accessRole }, events: new Map(), log: [] });
  }
  private cal(id: string) {
    const c = this.calendars.get(id);
    if (!c) throw new Error(`no calendar ${id}`);
    return c;
  }
  /** Simulates the user editing Google directly. */
  edit(calendarId: string, event: GoogleEvent) {
    const c = this.cal(calendarId);
    const next = { ...(c.events.get(event.id) ?? {}), ...event, etag: `e${++this.clock}` };
    c.events.set(event.id, next);
    c.log.push({ at: this.clock, id: event.id });
  }
  async listCalendars() {
    return [...this.calendars.values()].map((c) => c.info);
  }
  async createCalendar(name: string) {
    const id = `cal${++this.seq}`;
    this.add(id, name, "owner");
    return this.cal(id).info;
  }
  async listEvents(calendarId: string, opts: { syncToken?: string | null }) {
    this.calls.push(`list:${calendarId}:${opts.syncToken ? "inc" : "full"}`);
    const c = this.cal(calendarId);
    if (opts.syncToken) {
      if (this.expireTokens) throw new SyncTokenExpired();
      const since = Number(opts.syncToken);
      const ids = new Set(c.log.filter((l) => l.at > since).map((l) => l.id));
      return { events: [...ids].map((id) => c.events.get(id)!), nextSyncToken: String(this.clock) };
    }
    return { events: [...c.events.values()], nextSyncToken: String(this.clock) };
  }
  async insertEvent(calendarId: string, e: Omit<GoogleEvent, "id" | "etag">) {
    this.calls.push(`insert:${calendarId}`);
    const id = `ev${++this.seq}`;
    this.edit(calendarId, { ...e, id, status: "confirmed" });
    return this.cal(calendarId).events.get(id)!;
  }
  async patchEvent(calendarId: string, id: string, e: Omit<GoogleEvent, "id" | "etag">) {
    this.calls.push(`patch:${calendarId}`);
    this.edit(calendarId, { ...e, id });
    return this.cal(calendarId).events.get(id)!;
  }
  async deleteEvent(calendarId: string, id: string) {
    this.calls.push(`delete:${calendarId}`);
    if (this.cal(calendarId).events.has(id)) this.edit(calendarId, { id, status: "cancelled" });
  }
  studioEvents() {
    return [...this.cal("cal1").events.values()].filter((e) => e.status !== "cancelled");
  }
}

let app: FastifyInstance;
let root: string;
let ctx: ServiceContext;
const H = 3600000;
const T0 = Date.UTC(2027, 0, 12, 15, 0);
const NOW = Date.UTC(2027, 0, 1);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-gsync-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "T", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  ctx = { db: app.ctx.db, settings: app.ctx.settings, config, actorId: null };
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedShoot() {
  const c = createContact(ctx, { firstName: "Ana", lastName: "Ruiz", email: "ana@example.com" });
  const t = app.ctx.db.select().from(tables.shootType).all()[0]!;
  return createShoot(ctx, { primaryContactId: c.id, shootTypeId: t.id, events: [{ startsAt: T0, endsAt: T0 + 2 * H, location: "Park" }] }).shoot;
}

describe("google sync", () => {
  it("creates the OpenPortrait calendar and pushes shoot times and appointments", async () => {
    const g = new FakeGoogle();
    seedShoot();
    calendar.createEntry(ctx, { kind: "appointment", title: "Consult", startsAt: T0 + 24 * H, endsAt: T0 + 25 * H });
    const r = await syncGoogle(ctx, g, NOW);
    expect(r.pushed).toBe(2);
    expect(g.studioEvents().map((e) => e.summary).sort()).toEqual(["Ana Ruiz", "Consult"]);
    const shootEv = g.studioEvents().find((e) => e.summary === "Ana Ruiz")!;
    expect(shootEv.start?.dateTime).toBe(new Date(T0).toISOString());
    expect(shootEv.location).toBe("Park");
  });

  it("does not push unchanged items again, and sends edits as patches", async () => {
    const g = new FakeGoogle();
    const s = seedShoot();
    await syncGoogle(ctx, g, NOW);
    g.calls = [];
    await syncGoogle(ctx, g, NOW);
    expect(g.calls.filter((c) => c.startsWith("insert") || c.startsWith("patch"))).toEqual([]);
    updateEvent(ctx, s.id, s.events[0]!.id, { endsAt: T0 + 3 * H });
    await syncGoogle(ctx, g, NOW);
    expect(g.calls.filter((c) => c.startsWith("patch"))).toHaveLength(1);
    expect(g.studioEvents()[0]!.end?.dateTime).toBe(new Date(T0 + 3 * H).toISOString());
  });

  it("removes events from Google when the shoot time is removed or the shoot is cancelled", async () => {
    const g = new FakeGoogle();
    const s = seedShoot();
    const second = addEvent(ctx, s.id, { startsAt: T0 + 48 * H, endsAt: T0 + 49 * H }).shoot;
    await syncGoogle(ctx, g, NOW);
    expect(g.studioEvents()).toHaveLength(2);
    removeEvent(ctx, s.id, second.events.find((e: { startsAt: unknown }) => new Date(e.startsAt as string).getTime() === T0 + 48 * H)!.id);
    await syncGoogle(ctx, g, NOW);
    expect(g.studioEvents()).toHaveLength(1);
    updateShoot(ctx, s.id, { status: "cancelled" });
    await syncGoogle(ctx, g, NOW);
    expect(g.studioEvents()).toHaveLength(0);
  });

  it("applies a time edited in Google, and keeps the shoot's own title", async () => {
    const g = new FakeGoogle();
    const s = seedShoot();
    await syncGoogle(ctx, g, NOW);
    const ev = g.studioEvents()[0]!;
    g.edit("cal1", { id: ev.id, summary: "Renamed in Google", start: { dateTime: new Date(T0 + H).toISOString() }, end: { dateTime: new Date(T0 + 4 * H).toISOString() } });
    const r = await syncGoogle(ctx, g, NOW);
    expect(r.pulled).toBe(1);
    const times = calendar.listCalendar(ctx, T0 - DAY, T0 + DAY).filter((i) => i.source === "shoot");
    expect(times[0]!.startsAt).toBe(T0 + H);
    expect(times[0]!.endsAt).toBe(T0 + 4 * H);
    expect(times[0]!.title).toBe("Ana Ruiz");
    expect(s.id).toBe(times[0]!.shootId);
    // The title is put back in Google on the same pass.
    expect(g.studioEvents()[0]!.summary).toBe("Ana Ruiz");
  });

  it("imports events created in the OpenPortrait calendar in Google as appointments", async () => {
    const g = new FakeGoogle();
    await syncGoogle(ctx, g, NOW);
    g.edit("cal1", { id: "phone-made", summary: "Venue walk-through", status: "confirmed", start: { dateTime: new Date(T0).toISOString() }, end: { dateTime: new Date(T0 + H).toISOString() } });
    await syncGoogle(ctx, g, NOW);
    const items = calendar.listCalendar(ctx, T0 - DAY, T0 + DAY);
    expect(items.map((i) => [i.source, i.title])).toEqual([["appointment", "Venue walk-through"]]);
    // And it is not sent back as a second event.
    expect(g.studioEvents()).toHaveLength(1);
  });

  it("deletes an appointment here when it is deleted in Google, but restores a deleted shoot time", async () => {
    const g = new FakeGoogle();
    seedShoot();
    calendar.createEntry(ctx, { kind: "appointment", title: "Consult", startsAt: T0 + 24 * H, endsAt: T0 + 25 * H });
    await syncGoogle(ctx, g, NOW);
    for (const e of g.studioEvents()) g.edit("cal1", { id: e.id, status: "cancelled" });
    await syncGoogle(ctx, g, NOW);
    const items = calendar.listCalendar(ctx, T0 - DAY, T0 + 3 * DAY);
    expect(items.map((i) => i.source)).toEqual(["shoot"]);
    expect(g.studioEvents().map((e) => e.summary)).toEqual(["Ana Ruiz"]);
  });

  it("reads busy times from chosen calendars, without titles, and ignores free events", async () => {
    const g = new FakeGoogle();
    g.add("family", "Family", "reader");
    g.edit("family", { id: "a", summary: "Dentist (private)", status: "confirmed", start: { dateTime: new Date(T0).toISOString() }, end: { dateTime: new Date(T0 + H).toISOString() } });
    g.edit("family", { id: "b", summary: "Birthday", status: "confirmed", transparency: "transparent", start: { date: "2027-01-12" }, end: { date: "2027-01-13" } });
    setBusyCalendars(ctx, [{ id: "family", name: "Family" }]);
    await syncGoogle(ctx, g, NOW);
    const items = calendar.listCalendar(ctx, T0 - DAY, T0 + DAY);
    expect(items.map((i) => [i.source, i.title, i.startsAt])).toEqual([["busy", "Busy", T0]]);
    // Free-time search treats it as busy.
    expect(calendar.findFreeTime(ctx, T0 - H, T0 + 2 * H, 60)).toEqual([{ startsAt: T0 - H, endsAt: T0 }, { startsAt: T0 + H, endsAt: T0 + 2 * H }]);
    // Removing the calendar drops its cached times.
    setBusyCalendars(ctx, []);
    expect(calendar.listCalendar(ctx, T0 - DAY, T0 + DAY)).toEqual([]);
  });

  it("re-reads from scratch when Google expires the sync token", async () => {
    const g = new FakeGoogle();
    g.add("family", "Family", "reader");
    setBusyCalendars(ctx, [{ id: "family", name: "Family" }]);
    g.edit("family", { id: "a", status: "confirmed", start: { dateTime: new Date(T0).toISOString() }, end: { dateTime: new Date(T0 + H).toISOString() } });
    await syncGoogle(ctx, g, NOW);
    g.edit("family", { id: "a", status: "confirmed", start: { dateTime: new Date(T0 + H).toISOString() }, end: { dateTime: new Date(T0 + 2 * H).toISOString() } });
    g.expireTokens = true;
    g.calls = [];
    await syncGoogle(ctx, g, NOW);
    expect(g.calls).toContain("list:family:full");
    expect(calendar.listCalendar(ctx, T0 - DAY, T0 + DAY)[0]!.startsAt).toBe(T0 + H);
  });

  it("writes all-day events as dates in the studio time zone", async () => {
    const g = new FakeGoogle();
    const day = startOfDay("2027-02-03", "America/Chicago");
    calendar.createEntry(ctx, { kind: "block", title: "Away", startsAt: day, endsAt: startOfDay("2027-02-04", "America/Chicago"), allDay: true });
    await syncGoogle(ctx, g, NOW);
    const e = g.studioEvents()[0]!;
    expect(e.start).toEqual({ date: "2027-02-03" });
    expect(e.end).toEqual({ date: "2027-02-04" });
  });

  it("forgets everything on disconnect", async () => {
    const g = new FakeGoogle();
    seedShoot();
    ctx.settings.set("google.refreshToken", "r");
    await syncGoogle(ctx, g, NOW);
    disconnectGoogle(ctx);
    expect(ctx.settings.get("google.refreshToken")).toBeUndefined();
    expect(ctx.settings.get("google.studioCalendarId")).toBeUndefined();
  });
});

const DAY = 86400000;
