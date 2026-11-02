import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, control, type Deployment } from "./harness.js";

let d: Deployment;
beforeAll(async () => {
  d = await boot("authz");
});
afterAll(async () => d.close());

/** Routes that are public by design. Anything else under /api/studio must refuse an anonymous caller. */
const PUBLIC_STUDIO = [/^\/api\/studio\/setup/, /^\/api\/studio\/auth\/(login|login\/mfa|logout|me)$/];

describe("authorization", () => {
  control("AUTHZ-1", "every /api/studio route refuses an anonymous request", async () => {
    const studio = d.routes.filter((r) => r.url.startsWith("/api/studio") && !PUBLIC_STUDIO.some((p) => p.test(r.url)));
    expect(studio.length).toBeGreaterThan(100); // guards against the enumeration silently finding nothing
    const failures: string[] = [];
    for (const r of studio) {
      const url = r.url.replace(/:[A-Za-z]+/g, "x").replace(/\*/g, "x");
      const hasBody = ["POST", "PUT", "PATCH"].includes(r.method);
      const res = await d.app.inject({ method: r.method as "GET", url, ...(hasBody ? { headers: { "content-type": "application/json" }, payload: "{}" } : {}) });
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  control("AUTHZ-2", "a malformed, unknown or empty session cookie is treated as anonymous", async () => {
    for (const cookie of ["op_session=", "op_session=not-a-real-token", "op_session=" + "A".repeat(4000), "op_session=%00"]) {
      const res = await d.app.inject({ url: "/api/studio/galleries", headers: { cookie } });
      expect(res.statusCode).toBe(401);
    }
  });

  control("AUTHZ-3", "logging out ends the session on the server, so the old cookie stops working", async () => {
    const login = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "owner-authz@audit.invalid", password: "synthetic-Pass-12345" } });
    const cookie = `op_session=${login.cookies.find((c) => c.name === "op_session")!.value}`;
    expect((await d.app.inject({ url: "/api/studio/auth/me", headers: { cookie } })).json().user).not.toBeNull();
    await d.app.inject({ method: "POST", url: "/api/studio/auth/logout", headers: { cookie } });
    expect((await d.app.inject({ url: "/api/studio/auth/me", headers: { cookie } })).json().user).toBeNull();
  });

  control("AUTHZ-4", "each login issues a fresh session token (no fixation)", async () => {
    const body = { email: "owner-authz@audit.invalid", password: "synthetic-Pass-12345" };
    const a = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: body, headers: { cookie: "op_session=attacker-chosen" } });
    const b = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: body });
    const tok = (r: typeof a) => r.cookies.find((c) => c.name === "op_session")!.value;
    expect(tok(a)).not.toBe("attacker-chosen");
    expect(tok(a)).not.toBe(tok(b));
  });

  control("AUTHZ-5", "an unknown account and a wrong password get the same answer (no account enumeration)", async () => {
    const wrong = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "owner-authz@audit.invalid", password: "nope-nope-nope" } });
    const unknown = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "nobody@audit.invalid", password: "nope-nope-nope" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("the session cookie is HttpOnly and SameSite", async () => {
    const res = await d.app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "owner-authz@audit.invalid", password: "synthetic-Pass-12345" } });
    const c = res.cookies.find((x) => x.name === "op_session")!;
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe("lax");
  });
});
