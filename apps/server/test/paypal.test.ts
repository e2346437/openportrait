import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";
import { setPayPalFetch } from "../src/payments/paypal.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let calls: Array<{ url: string; method: string; body: string }>;
let verifyResult: string;
let captureStatus: string;
let captureCount: number;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakePayPal = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  if (u.endsWith("/v1/oauth2/token")) {
    const auth = String((init?.headers as Record<string, string>).authorization);
    return auth.includes(Buffer.from("cid:wrong").toString("base64")) ? json(401, {}) : json(200, { access_token: "tok", expires_in: 3600 });
  }
  if (u.endsWith("/v2/checkout/orders")) return json(201, { id: "PP-ORDER-1", links: [{ rel: "payer-action", href: "https://paypal.test/approve/PP-ORDER-1" }] });
  if (u.endsWith("/capture")) {
    captureCount++;
    if (captureCount > 1) return json(422, {});
    return json(201, { id: "PP-ORDER-1", status: "COMPLETED", payer: { email_address: "buyer@example.com" }, purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: captureStatus, amount: { value: JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!.body).purchase_units[0].amount.value } }] } }] });
  }
  if (u.endsWith("/v2/checkout/orders/PP-ORDER-1")) return json(200, { id: "PP-ORDER-1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED", amount: { value: JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!.body).purchase_units[0].amount.value } }] } }] });
  if (u.endsWith("/v1/notifications/verify-webhook-signature")) return json(200, { verification_status: verifyResult });
  return json(404, {});
}) as unknown as typeof fetch;

beforeEach(async () => {
  calls = [];
  verifyResult = "SUCCESS";
  captureStatus = "COMPLETED";
  captureCount = 0;
  setTransportFactory(() => ({ sendMail: async () => ({}) as never }));
  setPayPalFetch(fakePayPal);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-paypal-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "America/Chicago" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  app.ctx.settings.set("internet.publicUrl", "https://studio.example.com");
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
    const event = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", custom_id: attempt.id, amount: { value: "1000.00" } } };
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
