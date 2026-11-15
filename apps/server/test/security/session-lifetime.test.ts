import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { expect, it } from "vitest";
import { boot } from "./harness.js";

it("expires an idle session and separately enforces the absolute expiry", async () => {
  const studio = await boot("session-lifetime");
  try {
    const id = createHash("sha256").update(studio.cookie.slice("op_session=".length)).digest("hex");
    const db = studio.app.ctx.db;
    const me = () => studio.app.inject({ url: "/api/studio/auth/me", headers: { cookie: studio.cookie } });
    expect((await me()).json().user).not.toBeNull();
    db.update(tables.session).set({ lastSeenAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(tables.session.id, id)).run();
    expect((await me()).json().user).toBeNull();
    db.update(tables.session).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.session.id, id)).run();
    expect((await me()).json().user).toBeNull();
  } finally {
    await studio.close();
  }
});
