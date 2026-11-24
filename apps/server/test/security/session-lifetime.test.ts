import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, control, OWNER, type Deployment } from "./harness.js";

const HOUR = 3_600_000;

it("expires an idle session and separately enforces the absolute expiry", async () => {
  const studio = await boot("session-lifetime");
  try {
    const id = createHash("sha256").update(studio.cookie.slice("op_session=".length)).digest("hex");
    const db = studio.app.ctx.db;
    const me = () => studio.app.inject({ url: "/api/studio/auth/me", headers: { cookie: studio.cookie } });
    expect((await me()).json().user).not.toBeNull();
    db.update(tables.session).set({ lastSeenAt: new Date(Date.now() - 25 * HOUR) }).where(eq(tables.session.id, id)).run();
    expect((await me()).json().user).toBeNull();
    db.update(tables.session).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.session.id, id)).run();
    expect((await me()).json().user).toBeNull();
  } finally {
    await studio.close();
  }
});

// SEC-016 retest: the 24-hour idle expiry, checked from a real sign-in rather than the setup cookie.
describe("SEC-016 idle-session expiry", () => {
  let d: Deployment;
  beforeAll(async () => {
    d = await boot("sec016-idle");
  });
  afterAll(async () => d.close());

  /** A fresh sign-in with the owner's password, returning the cookie and a way to age that one session in the database. */
  async function signIn() {
    const login = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "owner-sec016-idle@audit.invalid", password: OWNER.password } });
    expect(login.statusCode).toBe(200);
    const token = login.cookies.find((c) => c.name === "op_session")!.value;
    const id = createHash("sha256").update(token).digest("hex");
    const cookie = `op_session=${token}`;
    const row = () => d.app.ctx.db.select().from(tables.session).where(eq(tables.session.id, id)).get()!;
    return {
      cookie,
      row,
      idleFor: (ms: number) => d.app.ctx.db.update(tables.session).set({ lastSeenAt: new Date(Date.now() - ms) }).where(eq(tables.session.id, id)).run(),
      me: async () => (await d.app.inject({ url: "/api/studio/auth/me", headers: { cookie } })).json().user as { email: string } | null,
      protectedRoute: async () => (await d.app.inject({ url: "/api/studio/contacts", headers: { cookie } })).statusCode,
    };
  }

  control("SEC-016", "a session idle for just over 24 hours is refused, on /auth/me and on a protected route", async () => {
    const s = await signIn();
    expect(await s.protectedRoute()).toBe(200);
    s.idleFor(24 * HOUR + 60_000);
    expect(await s.me()).toBeNull();
    expect(await s.protectedRoute()).toBe(401);
  });

  control("SEC-016b", "a session idle for just under 24 hours still works", async () => {
    const s = await signIn();
    s.idleFor(24 * HOUR - 60_000);
    expect((await s.me())?.email).toBe("owner-sec016-idle@audit.invalid");
    expect(await s.protectedRoute()).toBe(200);
  });

  control("SEC-016c", "use renews the idle clock, so activity keeps a session alive and a later gap is measured from the last use", async () => {
    const s = await signIn();
    s.idleFor(23 * HOUR);
    expect(await s.me()).not.toBeNull();
    // That request was recent activity: the stored last-seen time moved to about now.
    expect(Date.now() - s.row().lastSeenAt.getTime()).toBeLessThan(60_000);
    // Another 23 hours of quiet is fine, because the clock restarted. Total age is now past 46 hours.
    s.idleFor(23 * HOUR);
    expect(await s.me()).not.toBeNull();
    s.idleFor(25 * HOUR);
    expect(await s.me()).toBeNull();
  });

  control("SEC-016d", "an expired session cannot revive itself: refused requests do not renew it", async () => {
    const s = await signIn();
    s.idleFor(30 * HOUR);
    const before = s.row().lastSeenAt.getTime();
    for (let i = 0; i < 3; i++) expect(await s.me()).toBeNull();
    expect(s.row().lastSeenAt.getTime()).toBe(before);
    expect(await s.protectedRoute()).toBe(401);
  });

  control("SEC-016e", "a new sign-in is unaffected by another session having gone idle", async () => {
    const old = await signIn();
    old.idleFor(48 * HOUR);
    const fresh = await signIn();
    expect(await old.me()).toBeNull();
    expect(await fresh.me()).not.toBeNull();
  });

  control("SEC-016f", "the absolute limit is 30 days from sign-in, however recently the session was used", async () => {
    const s = await signIn();
    const days = (s.row().expiresAt.getTime() - Date.now()) / (24 * HOUR);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    d.app.ctx.db.update(tables.session).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.session.id, s.row().id)).run();
    expect(await s.me()).toBeNull();
  });
});
