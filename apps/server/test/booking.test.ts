import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";
import { addDays, atTime, weekdayOf, ymdIn } from "../src/domain/time.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let sent: Array<{ to: unknown; subject: string; text: string }>;
const TZ = "America/Chicago";

beforeEach(async () => {
  sent = [];
  setTransportFactory(() => ({
    sendMail: async (m: { to: unknown; subject: string; text: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
      return {} as never;
    },
  }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-book-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: TZ } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  app.ctx.settings.set("studio.email", "owner@example.com");
});
afterEach(async () => {
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const staff = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const pub = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/public${url}`, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const smtp = { host: "smtp.example.com", port: 587, security: "starttls", user: "u", password: "secret-pass", fromName: "Lumen Studio", fromAddress: "hello@example.com" };

/** The first Monday at least ten days from now, as year-month-day in the studio zone. */
function monday() {
  let d = addDays(ymdIn(Date.now(), TZ), 10);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}
const mondayHours = { "1": [{ start: "09:00", end: "12:00" }] };

describe("email", () => {
  it("saves settings without ever returning the password, and sends a test", async () => {
    expect((await staff("GET", "/email")).body.configured).toBe(false);
    expect((await staff("PUT", "/email", { ...smtp, host: "" })).status).toBe(400);
    const saved = await staff("PUT", "/email", smtp);
    expect(saved.body).toMatchObject({ configured: true, hasPassword: true, host: "smtp.example.com" });
    expect(JSON.stringify(saved.body)).not.toContain("secret-pass");
    const t = await staff("POST", "/email/test");
    expect(t.body).toEqual({ ok: true, to: "pat@example.com" });
    expect(sent[0]!.subject).toMatch(/Test email/);
    // Saving again without a password keeps the old one.
    await staff("PUT", "/email", { ...smtp, password: undefined, fromName: "Pat" });
    expect((await staff("GET", "/email")).body.hasPassword).toBe(true);
  });

  it("explains a refused login in plain words", async () => {
    await staff("PUT", "/email", smtp);
    setTransportFactory(() => ({
      sendMail: async () => {
        throw Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });
      },
    }));
    const t = await staff("POST", "/email/test");
    expect(t.status).toBe(502);
    expect(t.body.message).toMatch(/app password/i);
  });
});

describe("inquiry form", () => {
  it("files the inquiry and emails the client and the owner", async () => {
    await staff("PUT", "/email", smtp);
    const info = (await pub("GET", "/inquiry")).body;
    expect(info.shootTypes.length).toBeGreaterThan(0);
    const res = await pub("POST", "/inquiry", { firstName: "Dana", lastName: "Reyes", email: "Dana@Example.com", shootTypeId: info.shootTypes[0].id, message: "Family portraits in May?" });
    expect(res.body).toEqual({ ok: true });
    const board = (await staff("GET", "/leads")).body;
    const card = JSON.stringify(board);
    expect(card).toContain("Dana Reyes");
    await app.ctx.jobs.drain();
    expect(sent.map((m) => m.subject).sort()).toEqual(["New inquiry: Dana Reyes", "We got your message, Dana"]);
    expect(sent.find((m) => m.subject.startsWith("New inquiry"))!.text).toContain("Family portraits in May?");
    // The same person writing again reuses their contact.
    await pub("POST", "/inquiry", { firstName: "Dana", email: "dana@example.com" });
    expect(((await staff("GET", "/contacts?q=reyes")).body.items as unknown[]).length).toBe(1);
  });

  it("works without email set up, ignores bots, checks the address, and can be turned off", async () => {
    expect((await pub("POST", "/inquiry", { firstName: "Sam", email: "sam@example.com" })).body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    await pub("POST", "/inquiry", { firstName: "Bot", email: "bot@example.com", website: "http://spam" });
    expect(((await staff("GET", "/contacts?q=bot")).body.items as unknown[]).length).toBe(0);
    expect((await pub("POST", "/inquiry", { firstName: "X", email: "nope" })).status).toBe(400);
    expect((await pub("POST", "/inquiry", { firstName: "", email: "x@example.com" })).status).toBe(400);
    await staff("PUT", "/inquiry", { enabled: false });
    expect((await pub("POST", "/inquiry", { firstName: "Late", email: "late@example.com" })).status).toBe(403);
  });
});

describe("schedulers and booking pages", () => {
  async function make(extra: object = {}) {
    return (await staff("POST", "/schedulers", { name: "Intro call", durationMinutes: 60, stepMinutes: 60, minNoticeHours: 0, availability: mondayHours, ...extra })).body;
  }
  const slotsOn = async (slug: string, day: string) => (await pub("GET", `/book/${slug}/slots?from=${day}&to=${day}`)).body.days[day] as Array<{ startsAt: number; endsAt: number }> | undefined;

  it("creates a page with a clean address and validates hours", async () => {
    const s = await make({ name: "Mini Session!" });
    expect(s.slug).toBe("mini-session");
    expect((await make({ name: "Mini Session!" })).slug).toBe("mini-session-2");
    expect((await staff("POST", "/schedulers", { name: "Bad", durationMinutes: 60, availability: { "1": [{ start: "12:00", end: "09:00" }] } })).status).toBe(400);
    expect((await staff("POST", "/schedulers", { name: "Bad", durationMinutes: 60, availability: { "1": [{ start: "09:00", end: "11:00" }, { start: "10:00", end: "12:00" }] } })).status).toBe(400);
    expect((await staff("POST", "/schedulers", { name: "Bad", durationMinutes: 1, availability: {} })).status).toBe(400);
  });

  it("offers only open hours, in the studio's time zone, and respects the calendar", async () => {
    const s = await make();
    const day = monday();
    const slots = (await slotsOn(s.slug, day))!;
    expect(slots.map((x) => x.startsAt)).toEqual([atTime(day, "09:00", TZ), atTime(day, "10:00", TZ), atTime(day, "11:00", TZ)]);
    expect(await slotsOn(s.slug, addDays(day, 1))).toBeUndefined(); // Tuesday has no hours
    // A shoot-time or block at 10:30 to 11:30 removes the 10:00 and 11:00 starts.
    await staff("POST", "/calendar/entries", { kind: "block", title: "Away", startsAt: atTime(day, "10:30", TZ), endsAt: atTime(day, "11:30", TZ) });
    expect((await slotsOn(s.slug, day))!.map((x) => x.startsAt)).toEqual([atTime(day, "09:00", TZ)]);
  });

  it("keeps buffers and minimum notice", async () => {
    const day = monday();
    const buffered = await make({ name: "Buffered", bufferAfterMinutes: 30 });
    await staff("POST", "/calendar/entries", { kind: "block", title: "Busy", startsAt: atTime(day, "10:15", TZ), endsAt: atTime(day, "10:45", TZ) });
    // 09:00-10:00 plus 30 minutes after runs into the 10:15 block, so only 11:00 remains free.
    expect((await slotsOn(buffered.slug, day))!.map((x) => x.startsAt)).toEqual([atTime(day, "11:00", TZ)]);
    const far = await make({ name: "Far off", minNoticeHours: 24 * 30 });
    expect(await slotsOn(far.slug, day)).toBeUndefined();
  });

  it("holds a requested time, blocks a double booking, and emails both sides", async () => {
    await staff("PUT", "/email", smtp);
    const s = await make();
    const day = monday();
    const at = atTime(day, "09:00", TZ);
    const r = await pub("POST", `/book/${s.slug}`, { startsAt: at, firstName: "Ana", lastName: "Ruiz", email: "ana@example.com", message: "Looking forward" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending");
    // The time is held on the calendar straight away and gone from the page.
    const cal = (await staff("GET", `/calendar?from=${at - 1000}&to=${at + 3_600_000}`)).body.items;
    expect(cal.map((i: { title: string }) => i.title)).toEqual(["Pending: Intro call: Ana Ruiz"]);
    expect((await slotsOn(s.slug, day))!.map((x) => x.startsAt)).not.toContain(at);
    const again = await pub("POST", `/book/${s.slug}`, { startsAt: at, firstName: "Bo", email: "bo@example.com" });
    expect(again.status).toBe(409);
    // A time the page never offered is refused too.
    expect((await pub("POST", `/book/${s.slug}`, { startsAt: at + 5 * 60_000, firstName: "Bo", email: "bo@example.com" })).status).toBe(409);
    await app.ctx.jobs.drain();
    expect(sent.map((m) => m.subject).sort()).toEqual(["Booking request received: Intro call", "Booking request: Ana Ruiz, Intro call"]);
    const toClient = sent.find((m) => m.subject.startsWith("Booking request received"))!;
    expect(toClient.text).toMatch(/cancel/i);
    // It's in the staff list, and also an inquiry on the board.
    const pending = (await staff("GET", "/bookings?status=pending")).body.items;
    expect(pending).toHaveLength(1);
    expect(JSON.stringify((await staff("GET", "/leads")).body)).toContain("Ana Ruiz");
  });

  it("confirms, declines and cancels", async () => {
    const s = await make();
    const day = monday();
    const book = async (time: string, email: string) => (await pub("POST", `/book/${s.slug}`, { startsAt: atTime(day, time, TZ), firstName: "A", email })).body;
    const one = await book("09:00", "a1@example.com");
    const two = await book("10:00", "a2@example.com");
    const three = await book("11:00", "a3@example.com");
    expect((await staff("POST", `/bookings/${one.id}/confirm`)).body.status).toBe("confirmed");
    expect((await staff("POST", `/bookings/${one.id}/confirm`)).status).toBe(400);
    const titles = async () => (await staff("GET", `/calendar?from=${atTime(day, "00:00", TZ)}&to=${atTime(day, "23:59", TZ)}`)).body.items.map((i: { title: string }) => i.title).sort();
    expect(await titles()).toEqual(["Intro call: A", "Pending: Intro call: A", "Pending: Intro call: A"]);
    // Declining frees the time again.
    expect((await staff("POST", `/bookings/${two.id}/decline`, { reason: "Out that day" })).status).toBe(200);
    expect((await slotsOn(s.slug, day))!.map((x) => x.startsAt)).toContain(atTime(day, "10:00", TZ));
    // The client cancels from their link.
    const info = await pub("GET", `/book-cancel/${three.cancelToken}`);
    expect(info.body).toMatchObject({ name: "Intro call", status: "pending" });
    expect((await pub("POST", `/book-cancel/${three.cancelToken}`)).body.status).toBe("cancelled");
    expect((await slotsOn(s.slug, day))!.map((x) => x.startsAt)).toContain(atTime(day, "11:00", TZ));
    expect((await pub("GET", "/book-cancel/not-a-token")).status).toBe(404);
    // The owner can cancel a confirmed one.
    await staff("POST", `/bookings/${one.id}/cancel`);
    expect((await slotsOn(s.slug, day))!.map((x) => x.startsAt)).toContain(atTime(day, "09:00", TZ));
  });

  it("confirms at once when approval is automatic, and hides pages that are off", async () => {
    const s = await make({ approval: "auto" });
    const day = monday();
    const r = await pub("POST", `/book/${s.slug}`, { startsAt: atTime(day, "09:00", TZ), firstName: "A", email: "auto@example.com" });
    expect(r.body.status).toBe("confirmed");
    expect(((await staff("GET", `/calendar?from=${atTime(day, "00:00", TZ)}&to=${atTime(day, "23:59", TZ)}`)).body.items[0] as { title: string }).title).toBe("Intro call: A");
    await staff("PATCH", `/schedulers/${s.id}`, { ...s, availability: s.availability, active: false });
    expect((await pub("GET", `/book/${s.slug}`)).status).toBe(404);
    expect((await staff("DELETE", `/schedulers/${s.id}`)).status).toBe(400); // has an upcoming booking
  });
});

describe("special dates and daily limits", () => {
  const make = async (extra: object = {}) => (await staff("POST", "/schedulers", { name: "Mini", durationMinutes: 60, stepMinutes: 60, minNoticeHours: 0, approval: "auto", availability: mondayHours, ...extra })).body;
  const slotsOn = async (slug: string, day: string) => ((await pub("GET", `/book/${slug}/slots?from=${day}&to=${day}`)).body.days[day] ?? []) as Array<{ startsAt: number }>;
  const hours = (day: string, ...t: string[]) => t.map((x) => atTime(day, x, TZ));

  it("closes a day, or opens one with different hours, instead of the weekly hours", async () => {
    const day = monday();
    const off = addDays(day, 7);
    const sat = addDays(day, 5);
    const s = await make({ dateOverrides: { [off]: [], [sat]: [{ start: "10:00", end: "12:00" }] } });
    expect((await slotsOn(s.slug, day)).map((x) => x.startsAt)).toEqual(hours(day, "09:00", "10:00", "11:00"));
    expect(await slotsOn(s.slug, off)).toEqual([]);
    expect((await slotsOn(s.slug, sat)).map((x) => x.startsAt)).toEqual(hours(sat, "10:00", "11:00"));
  });

  it("checks special dates when saving", async () => {
    const bad = await staff("POST", "/schedulers", { name: "X", durationMinutes: 30, availability: {}, dateOverrides: { "next friday": [] } });
    expect(bad.status).toBe(400);
    const worse = await staff("POST", "/schedulers", { name: "X", durationMinutes: 30, availability: {}, dateOverrides: { "2099-01-02": [{ start: "12:00", end: "10:00" }] } });
    expect(worse.body.message).toMatch(/end after it starts/);
  });

  it("stops offering a day once its limit is reached, and frees it when someone cancels", async () => {
    const day = monday();
    const s = await make({ maxPerDay: 2 });
    const book = (n: number, h: string) => pub("POST", `/book/${s.slug}`, { startsAt: atTime(day, h, TZ), firstName: `P${n}`, email: `p${n}@example.com` });
    const a = await book(1, "09:00");
    expect(a.status).toBe(201);
    expect((await book(2, "10:00")).status).toBe(201);
    expect(await slotsOn(s.slug, day)).toEqual([]);
    expect((await book(3, "11:00")).status).toBe(409);
    await pub("POST", `/book-cancel/${a.body.cancelToken}`);
    expect((await slotsOn(s.slug, day)).length).toBe(2);
  });

  it("rejects a negative or silly daily limit", async () => {
    expect((await staff("POST", "/schedulers", { name: "X", durationMinutes: 30, availability: {}, maxPerDay: -1 })).status).toBe(400);
  });
});

describe("bookings that become shoots", () => {
  const typeId = async () => (await staff("GET", "/shoot-types")).body.types[0].id as string;
  const make = async (extra: object = {}) => (await staff("POST", "/schedulers", { name: "Mini session", durationMinutes: 60, stepMinutes: 60, minNoticeHours: 0, availability: mondayHours, shootTypeId: await typeId(), createShoot: true, ...extra })).body;
  const shoots = async () => (await staff("GET", "/shoots")).body.items as Array<{ id: string; subject: string; status: string }>;
  const who = { firstName: "Ana", lastName: "Ruiz", email: "ana@example.com" };

  it("needs a shoot type", async () => {
    const r = await staff("POST", "/schedulers", { name: "X", durationMinutes: 30, availability: {}, createShoot: true });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/shoot type/);
  });

  it("makes the shoot when an instant booking is taken, with the time on the shoot and not twice on the calendar", async () => {
    const s = await make({ approval: "auto" });
    const day = monday();
    const at = atTime(day, "09:00", TZ);
    const r = await pub("POST", `/book/${s.slug}`, { ...who, startsAt: at });
    expect(r.status).toBe(201);
    const list = await shoots();
    expect(list.map((x) => x.subject)).toEqual(["Ana Ruiz"]);
    const cal = (await staff("GET", `/calendar?from=${at - 1000}&to=${at + 3_600_000}`)).body.items;
    expect(cal).toHaveLength(1);
    expect(cal[0].shootId ?? cal[0].kind).toBeTruthy();
    // Cancelling takes the shoot with it.
    await pub("POST", `/book-cancel/${r.body.cancelToken}`);
    expect((await shoots()).find((x) => x.subject === "Ana Ruiz")?.status).toBe("cancelled");
  });

  it("waits for approval, then makes the shoot when the request is confirmed", async () => {
    const s = await make();
    const day = monday();
    const r = await pub("POST", `/book/${s.slug}`, { ...who, startsAt: atTime(day, "10:00", TZ) });
    expect(await shoots()).toHaveLength(0);
    await staff("POST", `/bookings/${r.body.id}/confirm`);
    expect(await shoots()).toHaveLength(1);
  });

  it("sends the shoot type's form when the booking becomes a shoot", async () => {
    const t = await staff("POST", "/questionnaire-templates", { name: "Session details", intro: "Tell us more", fields: [{ label: "Anything we should know?", type: "text" }] });
    expect((await staff("PUT", `/shoot-types/${await typeId()}/questionnaire`, { templateId: t.body.id, sendMode: "on_booking" })).status).toBe(200);
    const s = await make({ approval: "auto" });
    expect((await pub("POST", `/book/${s.slug}`, { ...who, startsAt: atTime(monday(), "09:00", TZ) })).status).toBe(201);
    await app.ctx.jobs.drain();
    const shoot = (await shoots())[0];
    const list = await staff("GET", `/shoots/${shoot.id}/questionnaires`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ status: "sent", origin: "auto" });
  });

  it("leaves pages that don't ask for a shoot as they were", async () => {
    const s = await make({ createShoot: false, approval: "auto" });
    await pub("POST", `/book/${s.slug}`, { ...who, startsAt: atTime(monday(), "09:00", TZ) });
    expect(await shoots()).toHaveLength(0);
  });
});
