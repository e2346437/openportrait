import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";
import { setPayPalFetch, testPayPal } from "../src/payments/paypal.js";
import { addDays, atTime, weekdayOf, ymdIn } from "../src/domain/time.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let calls: Array<{ url: string; method: string; body: string }>;
let verifyResult: string;
let captureStatus: string;
let captureCount: number;

let lookupStatus: number;
/** How PayPal answers a capture request: normally, not at all, with a server error, or by refusing it. */
let captureMode: "ok" | "network" | "server-error" | "declined" | "refused-unspecific";
let tokenStatus: number;
let captureGate: Promise<void> | null;
/** How the held capture request finally answers, once its gate opens (a late answer after another path settled the attempt). */
let lateCapture: "ok" | "server-error" | "network" | "declined";
let override: { value?: string; currency?: string; orderId?: string; customId?: string };
/** What PayPal would return for the order, echoing what was created unless a test overrides a field. */
const orderBody = (status: string) => {
  const created = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!.body).purchase_units[0];
  return {
    id: override.orderId ?? "PP-ORDER-1",
    status: "COMPLETED",
    payer: { email_address: "buyer@example.com" },
    purchase_units: [{ custom_id: created.custom_id, payments: { captures: [{ id: "CAP-1", status, custom_id: override.customId ?? created.custom_id, amount: { value: override.value ?? created.amount.value, currency_code: override.currency ?? created.amount.currency_code } }] } }],
  };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakePayPal = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  if (u.endsWith("/v1/oauth2/token")) {
    const auth = String((init?.headers as Record<string, string>).authorization);
    if (tokenStatus !== 200) return json(tokenStatus, {});
    return auth.includes(Buffer.from("cid:wrong").toString("base64")) ? json(401, {}) : json(200, { access_token: "tok", expires_in: 3600 });
  }
  if (u.endsWith("/v2/checkout/orders")) return json(201, { id: "PP-ORDER-1", links: [{ rel: "payer-action", href: "https://paypal.test/approve/PP-ORDER-1" }] });
  if (u.endsWith("/capture")) {
    captureCount++;
    if (captureMode === "network") throw new TypeError("fetch failed");
    if (captureMode === "server-error") return json(500, {});
    if (captureMode === "declined") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] });
    if (captureMode === "refused-unspecific") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYER_ACTION_REQUIRED" }] });
    if (captureCount > 1) return json(422, {});
    if (captureGate) await captureGate;
    if (lateCapture === "network") throw new TypeError("fetch failed");
    if (lateCapture === "server-error") return json(500, {});
    if (lateCapture === "declined") { captureMode = "declined"; return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }); }
    return json(201, orderBody(captureStatus));
  }
  if (u.endsWith("/v2/checkout/orders/PP-ORDER-1") && (captureMode === "declined" || captureMode === "refused-unspecific")) return json(200, { id: "PP-ORDER-1", status: "APPROVED", purchase_units: [{ payments: {} }] });
  if (u.endsWith("/v2/checkout/orders/PP-ORDER-1")) return lookupStatus === 200 ? json(200, orderBody(captureStatus)) : json(lookupStatus, {});
  if (u.endsWith("/v1/notifications/verify-webhook-signature")) return json(200, { verification_status: verifyResult });
  return json(404, {});
}) as unknown as typeof fetch;

beforeEach(async () => {
  calls = [];
  verifyResult = "SUCCESS";
  captureStatus = "COMPLETED";
  captureCount = 0;
  captureGate = null;
  lateCapture = "ok";
  lookupStatus = 200;
  captureMode = "ok";
  tokenStatus = 200;
  override = {};
  setTransportFactory(() => ({ sendMail: async () => ({}) as never }));
  setPayPalFetch(fakePayPal);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-paypal-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  app.ctx.settings.set("internet.publicUrl", "https://studio.example.com");
  app.ctx.settings.set("studio.email", "owner@example.com");
  await app.inject({ method: "PUT", url: "/api/studio/email", payload: { host: "smtp.example.com", port: 587, security: "starttls", user: "u", password: "secret-pass", fromName: "Lumen Studio", fromAddress: "hello@example.com" }, headers: { cookie } });
  await app.inject({ method: "PUT", url: "/api/studio/payments/paypal", payload: { clientId: "cid", clientSecret: "sec", mode: "sandbox", webhookId: "WH-1" }, headers: { cookie } });
});
afterEach(async () => {
  setPayPalFetch(null);
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const staff = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const pub = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/public${url}`, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const hook = (event: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/public/paypal/webhook",
    payload: JSON.stringify(event),
    headers: { "content-type": "application/json", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-11-02T00:00:00Z", ...headers },
  });

async function invoice(schedule?: Array<{ label: string; amountCents: number }>) {
  const c = await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" });
  const q = await staff("POST", "/orders", { kind: "quote", contactId: c.body.id, title: "Smith wedding", lines: [{ description: "Wedding", unitCents: 100_000, taxable: false }], ...(schedule ? { schedule } : {}) });
  await staff("POST", `/orders/${q.body.id}/send`);
  await pub("POST", `/order/${q.body.token}/accept`, { name: "Jane Smith" });
  return { id: q.body.id as string, token: q.body.token as string };
}
const completed = (attemptId: string, over: Record<string, unknown> = {}) => ({
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP-1", status: "COMPLETED", custom_id: attemptId, amount: { value: "1000.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "PP-ORDER-1" } }, ...over },
});
const attemptRow = () => app.ctx.db.$client.prepare("select id, status, currency, review_note as reviewNote from payment_attempt").get() as { id: string; status: string; currency: string | null; reviewNote: string | null };
const paymentCount = () => (app.ctx.db.$client.prepare("select count(*) as n from payment").get() as { n: number }).n;
const split = [{ label: "Deposit", amountCents: 30_000 }, { label: "Balance", amountCents: 70_000 }];

describe("PayPal settings", () => {
  it("keeps the secret hidden and builds the webhook address", async () => {
    const r = await staff("GET", "/payments/paypal");
    expect(r.body).toMatchObject({ clientId: "cid", hasSecret: true, mode: "sandbox", configured: true, webhookUrl: "https://studio.example.com/api/public/paypal/webhook" });
    expect(JSON.stringify(r.body)).not.toContain("sec\"");
    await staff("PUT", "/payments/paypal", { clientId: "cid2", mode: "live", webhookId: "" });
    expect((await staff("GET", "/payments/paypal")).body).toMatchObject({ clientId: "cid2", hasSecret: true, mode: "live" });
  });
  it("tests credentials and explains a rejection", async () => {
    expect((await staff("POST", "/payments/paypal/test")).status).toBe(200);
    await staff("PUT", "/payments/paypal", { clientId: "cid", clientSecret: "wrong", mode: "sandbox", webhookId: "" });
    const bad = await staff("POST", "/payments/paypal/test");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/client ID and secret/);
  });
});

describe("paying online", () => {
  it("offers the next payment and the full balance", async () => {
    const { token } = await invoice(split);
    expect((await pub("GET", `/order/${token}`)).body.pay).toEqual({ provider: "paypal", name: "PayPal", dueCents: 30_000, balanceCents: 100_000 });
  });
  it("is not offered until PayPal is set up", async () => {
    const { token } = await invoice();
    await staff("PUT", "/payments/paypal", { clientId: "", mode: "sandbox", webhookId: "" });
    expect((await pub("GET", `/order/${token}`)).body.pay).toBeNull();
    expect((await pub("POST", `/order/${token}/pay`, { amount: "due" })).status).toBe(400);
  });
  it("sends the client to PayPal, records the payment once on return, and ignores a repeat", async () => {
    const { id, token } = await invoice(split);
    const start = await pub("POST", `/order/${token}/pay`, { amount: "due" });
    expect(start.body).toMatchObject({ approveUrl: "https://paypal.test/approve/PP-ORDER-1" });
    const create = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!.body);
    expect(create.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "300.00" });
    expect(create.payment_source.paypal.experience_context.return_url).toBe(`https://studio.example.com/o/${token}?pay=return`);

    const back = await pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
    expect(back.body).toMatchObject({ outcome: "paid", paidCents: 30_000, balanceCents: 70_000 });
    const again = await pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
    expect(again.body).toMatchObject({ outcome: "paid", paidCents: 30_000 });

    const detail = await staff("GET", `/orders/${id}`);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.payments[0]).toMatchObject({ method: "paypal", amountCents: 30_000 });
  });
  it("pays the whole balance when asked", async () => {
    const { token } = await invoice(split);
    await pub("POST", `/order/${token}/pay`, { amount: "balance" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!.body).purchase_units[0].amount.value).toBe("1000.00");
    const back = await pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
    expect(back.body).toMatchObject({ state: "paid", balanceCents: 0 });
  });
  it("won't capture a payment that belongs to a different invoice", async () => {
    const a = await invoice();
    const b = await invoice();
    await pub("POST", `/order/${a.token}/pay`, { amount: "due" });
    expect((await pub("POST", `/order/${b.token}/pay/capture`, { providerOrderId: "PP-ORDER-1" })).status).toBe(404);
  });
  it("records nothing while PayPal still holds the payment", async () => {
    const { token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    captureStatus = "PENDING";
    const back = await pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
    expect(back.body).toMatchObject({ outcome: "pending", paidCents: 0 });
  });
});

describe("PayPal webhook", () => {
  it("rejects events PayPal doesn't vouch for", async () => {
    verifyResult = "FAILURE";
    expect((await hook({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} })).statusCode).toBe(401);
    expect((await hook({ event_type: "x" }, { "paypal-transmission-sig": "" })).statusCode).toBe(401);
  });
  it("forwards the body exactly as received for verification", async () => {
    const raw = '{"event_type":"OTHER",  "resource":{}}';
    await app.inject({ method: "POST", url: "/api/public/paypal/webhook", payload: raw, headers: { "content-type": "application/json", "paypal-auth-algo": "a", "paypal-cert-url": "https://c", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-transmission-time": "now" } });
    expect(calls.find((c) => c.url.endsWith("verify-webhook-signature"))!.body).toContain(`"webhook_event":${raw}`);
  });
  it("records a completed capture even if the client never came back, and only once", async () => {
    const { id, token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    const attempt = app.ctx.db.$client.prepare("select id from payment_attempt").get() as { id: string };
    const event = completed(attempt.id);
    expect((await hook(event)).statusCode).toBe(200);
    expect((await hook(event)).statusCode).toBe(200);
    const d = await staff("GET", `/orders/${id}`);
    expect(d.body.payments).toHaveLength(1);
    expect(d.body.state).toBe("paid");
  });
  it("records a refund PayPal made", async () => {
    const { id, token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    await pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
    const refund = { event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", amount: { value: "250.00" }, links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP-1" }] } };
    await hook(refund);
    await hook(refund);
    const d = await staff("GET", `/orders/${id}`);
    expect(d.body.payments).toHaveLength(2);
    expect(d.body.paidCents).toBe(75_000);
  });
});

describe("reconciling PayPal against the checkout", () => {
  const start = async () => {
    const { id, token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    return { id, token };
  };
  const ret = (token: string) => pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });

  it("stores the checkout currency on the attempt", async () => {
    await start();
    expect(attemptRow().currency).toBe("USD");
  });

  describe.each([
    ["amount", { value: "1.00" }],
    ["currency", { currency: "EUR" }],
    ["order identity", { orderId: "PP-OTHER" }],
    ["attempt identity", { customId: "someone-elses-attempt" }],
    ["malformed amount", { value: "abc" }],
  ])("browser return with the wrong %s", (_name, wrong) => {
    it("records nothing, holds the attempt for review, and keeps the invoice unpaid", async () => {
      const { id, token } = await start();
      override = wrong;
      const back = await ret(token);
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ outcome: "review", paidCents: 0 });
      expect(paymentCount()).toBe(0);
      expect(attemptRow().status).toBe("review");
      expect(attemptRow().reviewNote).toMatch(/may have been taken/);
      expect(JSON.stringify(attemptRow().reviewNote)).not.toContain("buyer@example.com");
      expect((await staff("GET", `/orders/${id}`)).body.state).not.toBe("paid");
      // A repeat visit doesn't capture again or record anything.
      const calledCapture = calls.filter((c) => c.url.endsWith("/capture")).length;
      expect((await ret(token)).body).toMatchObject({ outcome: "review" });
      expect(calls.filter((c) => c.url.endsWith("/capture")).length).toBe(calledCapture);
      expect(paymentCount()).toBe(0);
    });
  });

  describe.each([
    ["amount", { amount: { value: "1.00", currency_code: "USD" } }],
    ["currency", { amount: { value: "1000.00", currency_code: "EUR" } }],
    ["order identity", { supplementary_data: { related_ids: { order_id: "PP-OTHER" } } }],
    ["missing order identity", { supplementary_data: undefined }],
    ["status", { status: "DECLINED" }],
  ])("capture-completed webhook with the wrong %s", (_name, wrong) => {
    it("records nothing and holds the attempt for review", async () => {
      const { id } = await start();
      const res = await hook(completed(attemptRow().id, wrong));
      expect(res.statusCode).toBe(200);
      expect(paymentCount()).toBe(0);
      expect(attemptRow().status).toBe("review");
      expect((await staff("GET", `/orders/${id}`)).body.state).not.toBe("paid");
    });
  });

  it("ignores a webhook whose custom_id isn't one of our attempts", async () => {
    await start();
    expect((await hook(completed("someone-elses-attempt"))).statusCode).toBe(200);
    expect(paymentCount()).toBe(0);
    expect(attemptRow().status).toBe("started");
  });

  it("matching capture, return then webhook, records once", async () => {
    const { id, token } = await start();
    expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect((await staff("GET", `/orders/${id}`)).body.payments).toHaveLength(1);
  });

  it("matching webhook first, then return, records once", async () => {
    const { token } = await start();
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(1);
    expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
    expect(paymentCount()).toBe(1);
  });

  it("a repeated mismatching webhook is held once and doesn't re-notify", async () => {
    await start();
    const bad = completed(attemptRow().id, { amount: { value: "1.00", currency_code: "USD" } });
    await hook(bad);
    const notices = () => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = 'payment.review'").get() as { n: number }).n;
    expect(notices()).toBe(1);
    await hook(bad);
    expect(notices()).toBe(1);
    expect(paymentCount()).toBe(0);
  });

  it("still reconciles against the original currency after the studio changes its currency", async () => {
    const { id, token } = await start();
    app.ctx.settings.set("money.currency", "EUR");
    expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
    expect((await staff("GET", `/orders/${id}`)).body.payments).toHaveLength(1);
  });

  it("a studio currency change doesn't make a USD checkout's USD capture look wrong, and an EUR report is still refused", async () => {
    const { token } = await start();
    app.ctx.settings.set("money.currency", "EUR");
    override = { currency: "EUR" };
    expect((await ret(token)).body).toMatchObject({ outcome: "review" });
    expect(paymentCount()).toBe(0);
  });

  describe("capture-completed webhook with no custom_id", () => {
    const noCustom = (over: Record<string, unknown> = {}) => completed(attemptRow().id, { custom_id: undefined, ...over });
    const lookups = () => calls.filter((c) => c.method === "GET" && c.url.endsWith("/v2/checkout/orders/PP-ORDER-1")).length;
    const captures = () => calls.filter((c) => c.url.endsWith("/capture")).length;
    const notices = () => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = 'payment.review'").get() as { n: number }).n;

    it("records the payment when PayPal's order corroborates it, without capturing, and only once", async () => {
      const { id } = await start();
      expect((await hook(noCustom())).statusCode).toBe(200);
      expect((await hook(noCustom())).statusCode).toBe(200);
      expect(paymentCount()).toBe(1);
      expect(attemptRow().status).toBe("paid");
      expect(lookups()).toBe(1);
      expect(captures()).toBe(0);
      expect((await staff("GET", `/orders/${id}`)).body.state).toBe("paid");
    });
    it.each([
      ["a different capture id", () => {}, { id: "CAP-2" }],
      ["a capture PayPal shows as pending", () => { captureStatus = "PENDING"; }, {}],
      ["a conflicting attempt id on the order", () => { override = { customId: "someone-elses-attempt" }; }, {}],
      ["a conflicting amount on the order", () => { override = { value: "1.00" }; }, {}],
      ["a conflicting currency on the order", () => { override = { currency: "EUR" }; }, {}],
    ])("holds for review and records nothing with %s", async (_name, setup, extra) => {
      await start();
      setup();
      expect((await hook(noCustom(extra))).statusCode).toBe(200);
      expect(paymentCount()).toBe(0);
      expect(attemptRow().status).toBe("review");
      expect(notices()).toBe(1);
      expect(captures()).toBe(0);
    });
    it("holds for review when the event's own amount disagrees with the attempt", async () => {
      await start();
      await hook(noCustom({ amount: { value: "1.00", currency_code: "USD" } }));
      expect(paymentCount()).toBe(0);
      expect(attemptRow().status).toBe("review");
    });
    it("asks PayPal to retry, and records nothing, when the order can't be read", async () => {
      await start();
      lookupStatus = 500;
      expect((await hook(noCustom())).statusCode).toBe(500);
      expect(paymentCount()).toBe(0);
      expect(attemptRow().status).toBe("started");
      lookupStatus = 200;
      expect((await hook(noCustom())).statusCode).toBe(200);
      expect(paymentCount()).toBe(1);
    });
    it("ignores an event with neither custom_id nor a known order", async () => {
      await start();
      expect((await hook(noCustom({ supplementary_data: { related_ids: { order_id: "PP-OTHER" } } }))).statusCode).toBe(200);
      expect(paymentCount()).toBe(0);
      expect(attemptRow().status).toBe("started");
      expect(lookups()).toBe(0);
    });
    it("a legacy attempt is held without asking PayPal", async () => {
      await start();
      app.ctx.db.$client.prepare("update payment_attempt set currency = null").run();
      await hook(noCustom());
      expect(attemptRow().status).toBe("review");
      expect(lookups()).toBe(0);
      expect(paymentCount()).toBe(0);
    });
    it("leaves a payment the browser recorded while PayPal was being asked alone", async () => {
      const { token } = await start();
      const real = fakePayPal;
      setPayPalFetch((async (url: string, init?: RequestInit) => {
        const res = await real(url, init);
        if (String(url).endsWith("/v2/checkout/orders/PP-ORDER-1") && init?.method === "GET") {
          setPayPalFetch(real);
          await ret(token);
        }
        return res;
      }) as unknown as typeof fetch);
      expect((await hook(noCustom())).statusCode).toBe(200);
      expect(paymentCount()).toBe(1);
      expect(attemptRow().status).toBe("paid");
      expect(notices()).toBe(0);
    });
  });

  describe("a late browser response after a verified webhook settled the attempt", () => {
    const notices = () => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = 'payment.review'").get() as { n: number }).n;
    it.each([
      ["failed", () => { captureStatus = "DECLINED"; }],
      ["mismatched", () => { override = { value: "1.00" }; }],
    ])("a %s response changes nothing", async (_name, late) => {
      const { id, token } = await start();
      let release!: () => void;
      captureGate = new Promise<void>((r) => (release = r));
      const browser = ret(token);
      // Wait until the capture request is actually in flight.
      for (let i = 0; i < 200 && captureCount === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(captureCount).toBe(1);
      expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
      expect(attemptRow().status).toBe("paid");
      expect(paymentCount()).toBe(1);
      late();
      release();
      const back = await browser;
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ outcome: "paid" });
      expect(attemptRow()).toMatchObject({ status: "paid", reviewNote: null });
      expect(paymentCount()).toBe(1);
      expect(notices()).toBe(0);
      expect((await staff("GET", `/orders/${id}`)).body.state).toBe("paid");
    });
  });

  describe("legacy attempts with no stored currency", () => {
    const makeLegacy = () => app.ctx.db.$client.prepare("update payment_attempt set currency = null").run();

    it("is not captured automatically and is surfaced for manual reconciliation", async () => {
      const { token } = await start();
      makeLegacy();
      const back = await ret(token);
      expect(back.body).toMatchObject({ outcome: "review", paidCents: 0 });
      expect(calls.some((c) => c.url.endsWith("/capture"))).toBe(false);
      expect(attemptRow().status).toBe("review");
      expect(attemptRow().reviewNote).toMatch(/before its currency was stored/);
      expect(paymentCount()).toBe(0);
    });

    it("keeps the historical row and records nothing when a webhook reports a capture", async () => {
      await start();
      makeLegacy();
      expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
      expect(paymentCount()).toBe(0);
      expect(attemptRow()).toMatchObject({ status: "review", currency: null });
      expect(attemptRow().reviewNote).toMatch(/may have been taken/);
    });

    it("an already-paid legacy attempt stays paid", async () => {
      const { token } = await start();
      await ret(token);
      makeLegacy();
      expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
      expect(paymentCount()).toBe(1);
    });
  });
});

describe("an invoice voided while the client is paying", () => {
  const refundNotices = () => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = 'payment.void_paid'").get() as { n: number }).n;
  const reviewNotices = () => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = 'payment.review'").get() as { n: number }).n;
  const ledger = async (id: string) => (await staff("GET", `/orders/${id}`)).body;
  const start = async () => {
    const { id, token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    return { id, token };
  };
  const ret = (token: string) => pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
  const inFlight = async (token: string) => {
    let release!: () => void;
    captureGate = new Promise<void>((r) => (release = r));
    const browser = ret(token);
    for (let i = 0; i < 200 && captureCount === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(captureCount).toBe(1);
    return { browser, release };
  };

  it("does not start a capture after the void", async () => {
    const { id, token } = await start();
    await staff("POST", `/orders/${id}/void`);
    const r = await ret(token);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/no longer open/);
    expect(r.body.message).toMatch(/if you were charged earlier/i);
    expect(captureCount).toBe(0);
    expect((await ledger(id)).payments).toHaveLength(0);
    expect(attemptRow().status).toBe("failed");
  });
  it("answers an approval webhook for a void invoice without capturing or erroring", async () => {
    const { id } = await start();
    await staff("POST", `/orders/${id}/void`);
    expect((await hook({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "PP-ORDER-1" } })).statusCode).toBe(200);
    expect(captureCount).toBe(0);
  });
  it("records a valid capture that was in flight when the invoice was voided, keeps it void and tells the studio once", async () => {
    const { id, token } = await start();
    const { browser, release } = await inFlight(token);
    expect((await staff("POST", `/orders/${id}/void`)).status).toBe(200);
    release();
    const r = await browser;
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("paid");
    const d = await ledger(id);
    expect(d.state).toBe("void");
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ method: "paypal", amountCents: 100_000 });
    expect(refundNotices()).toBe(1);
    expect(attemptRow().status).toBe("paid");
    // A repeat return and a repeat webhook add nothing.
    expect((await ret(token)).body.outcome).toBe("paid");
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(1);
    expect(refundNotices()).toBe(1);
  });
  it("records a signed completed webhook on a void invoice once, however often it is delivered", async () => {
    const { id, token } = await start();
    await staff("POST", `/orders/${id}/void`);
    const event = completed(attemptRow().id);
    expect((await hook(event)).statusCode).toBe(200);
    expect((await hook(event)).statusCode).toBe(200);
    const d = await ledger(id);
    expect(d.payments).toHaveLength(1);
    expect(d.state).toBe("void");
    expect(refundNotices()).toBe(1);
    // A later return to the page can't capture again or double-record.
    expect((await ret(token)).body.outcome).toBe("paid");
    expect(paymentCount()).toBe(1);
    expect(captureCount).toBe(0);
  });
  it("records the capture when a failed attempt is later confirmed by webhook", async () => {
    const { id, token } = await start();
    await staff("POST", `/orders/${id}/void`);
    await ret(token);
    expect(attemptRow().status).toBe("failed");
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect((await ledger(id)).payments).toHaveLength(1);
    expect(refundNotices()).toBe(1);
  });
  it("a mismatched capture on a void invoice is held for review, not recorded", async () => {
    const { id, token } = await start();
    const { browser, release } = await inFlight(token);
    await staff("POST", `/orders/${id}/void`);
    override = { value: "1.00" };
    release();
    expect((await browser).body.outcome).toBe("review");
    expect(paymentCount()).toBe(0);
    expect(attemptRow().status).toBe("review");
    expect(reviewNotices()).toBe(1);
    expect(refundNotices()).toBe(0);
    expect((await ledger(id)).state).toBe("void");
  });
  it("a mismatched webhook on a void invoice does not settle it", async () => {
    const { id } = await start();
    await staff("POST", `/orders/${id}/void`);
    expect((await hook(completed(attemptRow().id, { amount: { value: "1.00", currency_code: "USD" } }))).statusCode).toBe(200);
    expect(paymentCount()).toBe(0);
    expect(attemptRow().status).toBe("review");
    expect((await ledger(id)).state).toBe("void");
  });
  it("a late failed response does not overwrite an attempt a webhook already paid on a void invoice", async () => {
    const { id, token } = await start();
    const { browser, release } = await inFlight(token);
    await staff("POST", `/orders/${id}/void`);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(attemptRow().status).toBe("paid");
    captureStatus = "DECLINED";
    release();
    const back = await browser;
    expect(back.body).toMatchObject({ outcome: "paid" });
    expect(attemptRow().status).toBe("paid");
    expect(paymentCount()).toBe(1);
    expect(refundNotices()).toBe(1);
    expect((await ledger(id)).state).toBe("void");
  });
  it("still refuses manual and credit payments, and PayPal money without a reference, once void", async () => {
    const { id } = await invoice();
    await staff("POST", `/orders/${id}/void`);
    const manual = await staff("POST", `/orders/${id}/payments`, { amountCents: 1000, method: "cash" });
    expect(manual.status).toBe(400);
    const orders = await import("../src/domain/orders.js");
    const ctx = app.ctx as never;
    expect(() => orders.recordPayment(ctx, id, { amountCents: 1000, method: "credit" }, { provider: "credit", providerRef: "x" })).toThrow();
    expect(() => orders.recordPayment(ctx, id, { amountCents: 1000, method: "paypal" }, { provider: "paypal" })).toThrow();
    expect(() => orders.recordPayment(ctx, id, { amountCents: 1000, method: "cash" }, { provider: "stripe", providerRef: "y" })).toThrow();
    expect(paymentCount()).toBe(0);
  });
});

describe("a booking cancelled while the client is paying", () => {
  const TZ = "America/Chicago";
  /** A paid booking page: booking it raises a sent invoice, and the client opens a PayPal checkout on it. */
  const booked = async () => {
    let day = addDays(ymdIn(Date.now(), TZ), 10);
    while (weekdayOf(day) !== 1) day = addDays(day, 1);
    const s = (await staff("POST", "/schedulers", { name: "Mini session", durationMinutes: 30, approval: "auto", priceCents: 20_000, depositType: "none", depositValue: 0, availability: { "1": [{ start: "09:00", end: "12:00" }] } })).body;
    const r = await pub("POST", `/book/${s.slug}`, { firstName: "Ana", email: "ana@example.com", startsAt: atTime(day, "09:00", TZ) });
    expect(r.status).toBe(201);
    const token = r.body.invoice.token as string;
    expect((await pub("POST", `/order/${token}/pay`, { amount: "due" })).status).toBe(200);
    const invoiceId = (app.ctx.db.$client.prepare("select order_id as id from scheduler_booking").get() as { id: string }).id;
    return { token, cancelToken: r.body.cancelToken as string, bookingId: r.body.id as string, invoiceId };
  };
  const stateOf = async (token: string) => (await pub("GET", `/order/${token}`)).body.state;
  const ret = (token: string) => pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });

  it("voids the invoice when the client cancels, then neither a return nor an approval webhook captures", async () => {
    const { token, cancelToken } = await booked();
    expect((await pub("POST", `/book-cancel/${cancelToken}`)).body.status).toBe("cancelled");
    expect(await stateOf(token)).toBe("void");
    expect((await ret(token)).status).toBe(409);
    expect((await hook({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "PP-ORDER-1" } })).statusCode).toBe(200);
    expect(captureCount).toBe(0);
    expect(paymentCount()).toBe(0);
    expect(attemptRow().status).toBe("failed");
  });
  it("voids the invoice when the owner cancels, and the approval webhook alone never captures", async () => {
    const { token, bookingId } = await booked();
    expect((await staff("POST", `/bookings/${bookingId}/cancel`)).status).toBe(200);
    expect(await stateOf(token)).toBe("void");
    expect((await hook({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "PP-ORDER-1" } })).statusCode).toBe(200);
    expect(captureCount).toBe(0);
    expect(paymentCount()).toBe(0);
  });
  it("records money captured while the booking was cancelled, on the void invoice, once", async () => {
    const { token, cancelToken, invoiceId } = await booked();
    let release!: () => void;
    captureGate = new Promise<void>((r) => (release = r));
    const browser = ret(token);
    for (let i = 0; i < 200 && captureCount === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(captureCount).toBe(1);
    await pub("POST", `/book-cancel/${cancelToken}`);
    release();
    expect((await browser).body.outcome).toBe("paid");
    expect(await stateOf(token)).toBe("void");
    expect(paymentCount()).toBe(1);
    expect((await staff("GET", `/orders/${invoiceId}`)).body.payments).toHaveLength(1);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(1);
  });
});

describe("when PayPal is unreachable or its answer is unclear", () => {
  const start = async () => {
    const { id, token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    return { id, token };
  };
  const ret = (token: string) => pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
  /** The access token is cached between requests, so drop it before simulating an outage. */
  const tokenDown = async (status: number) => {
    tokenStatus = status;
    await testPayPal(app.ctx).catch(() => undefined);
  };

  it("keeps the attempt open when the capture request gets no answer, and a signed webhook still settles it once", async () => {
    const { id, token } = await start();
    captureMode = "network";
    const back = await ret(token);
    expect(back.status).toBe(502);
    expect(JSON.stringify(back.body)).toMatch(/Couldn't reach PayPal/);
    expect(attemptRow().status).toBe("started");
    expect(paymentCount()).toBe(0);
    captureMode = "ok";
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(1);
    expect(attemptRow().status).toBe("paid");
    expect((await staff("GET", `/orders/${id}`)).body.state).toBe("paid");
  });

  it("says it can't tell whether the client was charged when PayPal answers the capture with a server error", async () => {
    const { token } = await start();
    captureMode = "server-error";
    const back = await ret(token);
    expect(back.status).toBe(502);
    expect(JSON.stringify(back.body)).toMatch(/can't tell whether you were charged/);
    expect(attemptRow().status).toBe("started");
    expect(paymentCount()).toBe(0);
  });

  it("starts no capture while PayPal can't issue an access token, and works once it recovers", async () => {
    const { token } = await start();
    await tokenDown(503);
    const back = await ret(token);
    expect(back.status).toBe(502);
    expect(captureCount).toBe(0);
    expect(attemptRow().status).toBe("started");
    expect(paymentCount()).toBe(0);
    tokenStatus = 200;
    expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
    expect(paymentCount()).toBe(1);
  });

  it("treats a refused capture with a decline reason and no captured money as a failed payment, not one in progress", async () => {
    const { token } = await start();
    captureMode = "declined";
    const back = await ret(token);
    expect(back.status).toBe(402);
    expect(JSON.stringify(back.body)).not.toMatch(/being processed/i);
    expect(attemptRow().status).toBe("failed");
    expect(paymentCount()).toBe(0);
    // A webhook that later confirms real money still lands, once.
    captureMode = "ok";
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(1);
  });

  it("keeps saying the payment is in progress when PayPal refuses without a clear reason", async () => {
    const { token } = await start();
    captureMode = "refused-unspecific";
    const back = await ret(token);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ outcome: "pending", paidCents: 0 });
    expect(attemptRow().status).toBe("started");
    expect(paymentCount()).toBe(0);
  });

  it("keeps saying the payment is in progress when PayPal says it was already captured but can't show the order", async () => {
    const { token } = await start();
    captureCount = 1; // the fake answers 422 from now on
    lookupStatus = 500;
    const back = await ret(token);
    expect(back.body).toMatchObject({ outcome: "pending", paidCents: 0 });
    expect(attemptRow().status).toBe("started");
    expect(paymentCount()).toBe(0);
  });

  it("answers a webhook with a retryable error, and records nothing, while PayPal can't verify signatures", async () => {
    const { token } = await start();
    await tokenDown(503);
    const res = await hook(completed(attemptRow().id));
    expect(res.statusCode).toBe(503);
    expect(paymentCount()).toBe(0);
    tokenStatus = 200;
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(1);
    expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
    expect(paymentCount()).toBe(1);
  });
});

describe("PayPal money that exceeds what the invoice still owed", () => {
  const count = (kind: string) => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = ?").get(kind) as { n: number }).n;
  const start = async (schedule?: Array<{ label: string; amountCents: number }>) => {
    const { id, token } = await invoice(schedule);
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    return { id, token };
  };
  const ret = (token: string) => pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });

  it("records all of it, leaves the ledger alone, and tells the studio once, even when the return and webhooks repeat", async () => {
    const { id, token } = await start();
    // A hand-recorded payment lands while the client is on PayPal's page.
    expect((await staff("POST", `/orders/${id}/payments`, { amountCents: 40_000, method: "cash" })).status).toBeLessThan(300);
    expect((await ret(token)).body).toMatchObject({ outcome: "paid" });
    const order = (await staff("GET", `/orders/${id}`)).body;
    expect(order.payments.map((p: { amountCents: number }) => p.amountCents).sort((a: number, b: number) => a - b)).toEqual([40_000, 100_000]);
    expect(count("payment.overpaid")).toBe(1);
    expect(count("payment.void_paid")).toBe(0);
    await ret(token);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(paymentCount()).toBe(2);
    expect(count("payment.overpaid")).toBe(1);
    // Nothing was refunded or credited on the studio's behalf.
    expect(order.payments.every((p: { amountCents: number }) => p.amountCents > 0)).toBe(true);
  });

  it("stays quiet for an exact payment and for a deposit that is part of the balance", async () => {
    const full = await start();
    await ret(full.token);
    expect(count("payment.overpaid")).toBe(0);
  });

  it("stays quiet for a scheduled deposit", async () => {
    const { token } = await start(split);
    expect((await ret(token)).body).toMatchObject({ outcome: "paid", paidCents: 30_000 });
    expect(count("payment.overpaid")).toBe(0);
  });

  it("does not add an overpayment notice on top of the refund-review notice for a voided invoice", async () => {
    const { id, token } = await start();
    let release!: () => void;
    captureGate = new Promise<void>((r) => (release = r));
    const browser = ret(token);
    for (let i = 0; i < 200 && captureCount === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await staff("POST", `/orders/${id}/void`)).status).toBeLessThan(300);
    release();
    await browser;
    expect(count("payment.void_paid")).toBe(1);
    expect(count("payment.overpaid")).toBe(0);
  });
});

// Pending Eric's decisions on refund accounting (see HANDOFF-PAYPAL-VOID.md, T1 and T4). Nothing here changes behaviour yet.
describe("return and webhook racing, and late processor errors after settlement", () => {
  const start = async () => {
    const { id, token } = await invoice();
    await pub("POST", `/order/${token}/pay`, { amount: "due" });
    return { id, token };
  };
  const ret = (token: string) => pub("POST", `/order/${token}/pay/capture`, { providerOrderId: "PP-ORDER-1" });
  const reviewNotices = () => (app.ctx.db.$client.prepare("select count(*) as n from activity where kind = 'payment.review'").get() as { n: number }).n;
  const inFlight = async (token: string) => {
    let release!: () => void;
    captureGate = new Promise<void>((r) => (release = r));
    const browser = ret(token);
    for (let i = 0; i < 200 && captureCount === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(captureCount).toBe(1);
    return { browser, release };
  };
  const settled = async (id: string) => {
    expect(attemptRow()).toMatchObject({ status: "paid", reviewNote: null });
    expect(paymentCount()).toBe(1);
    expect(reviewNotices()).toBe(0);
    expect((await staff("GET", `/orders/${id}`)).body.state).toBe("paid");
  };

  it("a return and a signed webhook arriving together record one payment", async () => {
    const { id, token } = await start();
    const [back, webhook] = await Promise.all([ret(token), hook(completed(attemptRow().id))]);
    expect(webhook.statusCode).toBe(200);
    expect(back.body).toMatchObject({ outcome: "paid" });
    await settled(id);
  });

  it("the same race with the webhook sent first records one payment", async () => {
    const { id, token } = await start();
    const [webhook, back] = await Promise.all([hook(completed(attemptRow().id)), ret(token)]);
    expect(webhook.statusCode).toBe(200);
    expect(back.body).toMatchObject({ outcome: "paid" });
    await settled(id);
  });

  it("two returns and two webhooks all arriving together record one payment", async () => {
    const { id, token } = await start();
    const attempt = attemptRow().id;
    const all = await Promise.all([ret(token), hook(completed(attempt)), ret(token), hook(completed(attempt))]);
    for (const r of all) expect(r.statusCode ?? r.status).toBe(200);
    await settled(id);
  });

  it("a webhook arriving at the moment the held capture answers records one payment", async () => {
    const { id, token } = await start();
    const { browser, release } = await inFlight(token);
    const [webhook, back] = await Promise.all([hook(completed(attemptRow().id)), (async () => { release(); return browser; })()]);
    expect(webhook.statusCode).toBe(200);
    expect(back.body).toMatchObject({ outcome: "paid" });
    await settled(id);
  });

  it.each([
    ["a server error", "server-error" as const],
    ["a network failure", "network" as const],
    ["a decline", "declined" as const],
  ])("%s answering the held capture after a webhook settled the attempt changes nothing", async (_name, mode) => {
    const { id, token } = await start();
    const { browser, release } = await inFlight(token);
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    expect(attemptRow().status).toBe("paid");
    lateCapture = mode;
    release();
    const back = await browser;
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ outcome: "paid" });
    await settled(id);
    // A repeat delivery afterwards still adds nothing.
    expect((await hook(completed(attemptRow().id))).statusCode).toBe(200);
    await settled(id);
  });
});

describe("processor refunds and reversals (decisions pending)", () => {
  it.todo("records nothing and flags for review when a refund exceeds the captured amount");
  it.todo("caps cumulative refunds on one capture at the captured amount");
  it.todo("refuses a refund in a different currency from the capture");
  it.todo("refuses a refund with a malformed or negative amount");
  it.todo("ignores a refund for a capture we don't hold, and dedupes a repeat refund id");
  it.todo("records a refund exactly equal to the remaining balance of the capture");
  it.todo("treats a staff refund followed by a PayPal refund of the same money as one refund");
  it.todo("applies a reversed or denied capture as a negative row with its own reference once the ledger treatment is chosen");
});
