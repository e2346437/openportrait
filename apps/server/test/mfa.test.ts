import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, OWNER, type Deployment } from "./security/harness.js";
import { base32Decode, base32Encode, totpCode, currentStep, verifyTotp } from "../src/totp.js";

let d: Deployment;
let email: string;
beforeAll(async () => {
  d = await boot("mfa");
  email = "owner-mfa@audit.invalid";
});
afterAll(async () => d.close());

const post = (url: string, payload: unknown, cookie = d.cookie) => d.app.inject({ method: "POST", url: `/api/studio/auth/${url}`, payload: payload as object, headers: cookie ? { cookie } : {} });
const login = () => post("login", { email, password: OWNER.password }, "");
const sessionCookie = (res: Awaited<ReturnType<typeof login>>) => {
  const c = res.cookies.find((x) => x.name === "op_session");
  return c ? `op_session=${c.value}` : "";
};

describe("TOTP primitives", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });

  it("allows one step of drift and refuses a replayed step", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(secret, totpCode(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), null, now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, "12345", null, now)).toBeNull();
  });
});

describe("two-step sign-in", () => {
  let secret = "";
  let recovery: string[] = [];

  it("is off by default and sign-in is unchanged", async () => {
    expect((await d.app.inject({ url: "/api/studio/auth/mfa", headers: { cookie: d.cookie } })).json()).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    expect(sessionCookie(await login())).not.toBe("");
  });

  it("needs the password to start setup and a valid code to finish it", async () => {
    expect((await post("mfa/setup", { password: "wrong-password-1" })).statusCode).toBe(400);
    const setup = await post("mfa/setup", { password: OWNER.password });
    expect(setup.statusCode).toBe(200);
    secret = setup.json().secret;
    expect(setup.json().uri).toContain(`secret=${secret}`);
    // Not active yet: sign-in still goes straight through.
    expect((await login()).json().mfaRequired).toBeUndefined();
    expect((await post("mfa/enable", { code: "000000" })).statusCode).toBe(400);
    const done = await post("mfa/enable", { code: totpCode(secret, currentStep()) });
    expect(done.statusCode).toBe(200);
    recovery = done.json().recoveryCodes;
    expect(recovery).toHaveLength(10);
  });

  it("stores the secret encrypted and recovery codes hashed", () => {
    const row = (d.app as any).ctx.db.$client.prepare("select totp_secret, recovery_codes from user limit 1").get();
    expect(row.totp_secret).not.toContain(secret);
    expect(row.recovery_codes).not.toContain(recovery[0]!.replace(/-/g, ""));
  });

  it("asks for a code after the password and gives no session until it is right", async () => {
    const first = await login();
    expect(first.json().mfaRequired).toBe(true);
    expect(sessionCookie(first)).toBe("");
    const { challenge } = first.json();
    const bad = await post("login/mfa", { challenge, code: "123456" }, "");
    expect(bad.statusCode).toBe(401);
    expect(sessionCookie(bad)).toBe("");
    expect((await post("login/mfa", { challenge: challenge + "x", code: "123456" }, "")).statusCode).toBe(401);
  });

  it("rejects a code that was already used, then accepts the next step", async () => {
    // The enable step consumed the current code; sign-in with it again must fail.
    const { challenge } = (await login()).json();
    const reused = await post("login/mfa", { challenge, code: totpCode(secret, currentStep()) }, "");
    expect(reused.statusCode).toBe(401);
    const next = await post("login/mfa", { challenge, code: totpCode(secret, currentStep() + 1) }, "");
    expect(next.statusCode).toBe(200);
    const cookie = sessionCookie(next);
    expect((await d.app.inject({ url: "/api/studio/auth/me", headers: { cookie } })).json().user.email).toBe(email);
  });

  it("accepts each recovery code once", async () => {
    const code = recovery[0]!;
    const ok = await post("login/mfa", { challenge: (await login()).json().challenge, code: code.toUpperCase() }, "");
    expect(ok.statusCode).toBe(200);
    const again = await post("login/mfa", { challenge: (await login()).json().challenge, code }, "");
    expect(again.statusCode).toBe(401);
    expect((await d.app.inject({ url: "/api/studio/auth/mfa", headers: { cookie: d.cookie } })).json().recoveryCodesLeft).toBe(9);
  });

  it("locks the account's second step after five wrong codes", async () => {
    const { challenge } = (await login()).json();
    for (let i = 0; i < 5; i++) await post("login/mfa", { challenge, code: "000000" }, "");
    const locked = await post("login/mfa", { challenge, code: recovery[1]! }, "");
    expect(locked.statusCode).toBe(429);
  });
});
