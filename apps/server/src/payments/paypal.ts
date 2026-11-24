import type { ServiceContext } from "../domain/context.js";
import { PaymentError, type CaptureResult, type CheckoutInput, type PaymentProvider } from "./provider.js";

type Ctx = Pick<ServiceContext, "settings">;

const BASES = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;

/** Tests swap this for a fake so nothing reaches PayPal. */
let doFetch: typeof fetch = (...a) => fetch(...a);
export const setPayPalFetch = (f: typeof fetch | null) => {
  doFetch = f ?? ((...a) => fetch(...a));
};

const base = (ctx: Ctx) => BASES[ctx.settings.get("paypal.mode") === "live" ? "live" : "sandbox"];

export function paypalConfigured(ctx: Ctx): boolean {
  return !!(ctx.settings.get("paypal.clientId") && ctx.settings.get("paypal.clientSecret"));
}

/** Whole-cent amounts as PayPal wants them ("12.34"). Currencies without cents aren't supported yet. */
const NO_CENTS = new Set(["JPY", "HUF", "TWD", "KRW", "CLP", "VND"]);
export function paypalAmount(cents: number, currency: string): string {
  if (NO_CENTS.has(currency)) throw new PaymentError(`PayPal checkout doesn't support ${currency} yet. Record payments by hand instead.`);
  return (cents / 100).toFixed(2);
}

let cached: { key: string; token: string; until: number } | null = null;

async function accessToken(ctx: Ctx): Promise<string> {
  const id = ctx.settings.get("paypal.clientId") ?? "";
  const secret = ctx.settings.get("paypal.clientSecret") ?? "";
  const key = `${base(ctx)}|${id}|${secret.length}`;
  if (cached && cached.key === key && cached.until > Date.now() + 30_000) return cached.token;
  const res = await doFetch(`${base(ctx)}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  }).catch(() => null);
  if (!res) throw new PaymentError("Couldn't reach PayPal. Check your internet connection and try again.");
  if (res.status === 401) throw new PaymentError("PayPal didn't accept the client ID and secret. Check that they are from the same app, and that Sandbox or Live matches.");
  if (!res.ok) throw new PaymentError(`PayPal returned an error (${res.status}).`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { key, token: body.access_token, until: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function call<T>(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const token = await accessToken(ctx);
  const res = await doFetch(`${base(ctx)}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  if (!res) throw new PaymentError("Couldn't reach PayPal. Please try again in a moment.");
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

/** Confirms the saved credentials work. */
export async function testPayPal(ctx: Ctx): Promise<void> {
  cached = null;
  await accessToken(ctx);
}

/** Issues PayPal gives on a refused capture when the payer's funding source was turned down, so no money was taken. */
const DECLINED = new Set(["INSTRUMENT_DECLINED", "TRANSACTION_REFUSED"]);

interface PayPalOrder {
  id: string;
  status: string;
  details?: Array<{ issue?: string }>;
  links?: Array<{ rel: string; href: string }>;
  payer?: { email_address?: string };
  purchase_units?: Array<{ custom_id?: string; reference_id?: string; payments?: { captures?: Array<{ id: string; status: string; custom_id?: string; amount?: { value?: string; currency_code?: string } }> } }>;
}

type Capture = NonNullable<NonNullable<NonNullable<PayPalOrder["purchase_units"]>[number]["payments"]>["captures"]>[number];
function toResult(order: PayPalOrder, cap: Capture): CaptureResult {
  const unit = order.purchase_units?.find((u) => u.payments?.captures?.includes(cap)) ?? order.purchase_units?.[0];
  return {
    status: cap.status === "COMPLETED" ? "completed" : cap.status === "PENDING" ? "pending" : "failed",
    amount: String(cap.amount?.value ?? ""),
    currency: String(cap.amount?.currency_code ?? ""),
    orderId: String(order.id ?? ""),
    customId: String(cap.custom_id ?? unit?.custom_id ?? ""),
    providerRef: cap.id,
    payerEmail: order.payer?.email_address,
  };
}

export const paypal: PaymentProvider = {
  id: "paypal",
  name: "PayPal",
  configured: paypalConfigured,

  async createCheckout(ctx, input: CheckoutInput) {
    const { status, json } = await call<PayPalOrder & { message?: string }>(
      ctx,
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: input.attemptId, custom_id: input.attemptId, description: input.description.slice(0, 120), amount: { currency_code: input.currency, value: paypalAmount(input.amountCents, input.currency) } }],
        payment_source: { paypal: { experience_context: { brand_name: input.studioName.slice(0, 120) || "Studio", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: input.returnUrl, cancel_url: input.cancelUrl } } },
      },
      { "PayPal-Request-Id": input.attemptId },
    );
    const approve = json.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (status >= 300 || !json.id || !approve) throw new PaymentError("PayPal couldn't start the payment. Please try again, or ask the studio for another way to pay.");
    return { providerOrderId: json.id, approveUrl: approve };
  },

  async capture(ctx, providerOrderId): Promise<CaptureResult> {
    const { status, json } = await call<PayPalOrder>(ctx, "POST", `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, {}, { "PayPal-Request-Id": `capture-${providerOrderId}` });
    let order = json;
    // Already captured (a webhook got there first, or the client reloaded): read it instead.
    if (status === 422 || status === 409) order = (await call<PayPalOrder>(ctx, "GET", `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`)).json;
    else if (status >= 300) throw new PaymentError("PayPal couldn't confirm the payment. We can't tell whether you were charged, so please check PayPal before paying again.");
    const unit = order.purchase_units?.[0];
    const cap = unit?.payments?.captures?.[0];
    if (!cap) {
      // PayPal said no, and its own order shows nothing was captured. That is a decline, not a payment still in progress.
      if (status === 422 && json.details?.some((d) => d.issue && DECLINED.has(d.issue))) return { status: "failed", amount: "", currency: "", orderId: "", customId: "", providerRef: "" };
      return { status: "pending", amount: "", currency: "", orderId: "", customId: "", providerRef: "" };
    }
    return toResult(order, cap);
  },

  async lookupCapture(ctx, providerOrderId, captureId): Promise<CaptureResult | null> {
    const { status, json } = await call<PayPalOrder>(ctx, "GET", `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`);
    if (status === 404) return null;
    if (status >= 300) throw new PaymentError("PayPal couldn't be asked about this order right now.");
    const cap = json.purchase_units?.flatMap((u) => u.payments?.captures ?? []).find((c) => c.id === captureId);
    return cap ? toResult(json, cap) : null;
  },
};

export interface WebhookHeaders {
  authAlgo?: string;
  certUrl?: string;
  transmissionId?: string;
  transmissionSig?: string;
  transmissionTime?: string;
}

/**
 * Asks PayPal whether a webhook really came from PayPal. The body is passed through exactly as received,
 * because re-encoding it would change the signature.
 */
export async function verifyWebhook(ctx: Ctx, h: WebhookHeaders, rawBody: string): Promise<boolean> {
  const webhookId = ctx.settings.get("paypal.webhookId");
  if (!webhookId || !h.authAlgo || !h.certUrl || !h.transmissionId || !h.transmissionSig || !h.transmissionTime) return false;
  const token = await accessToken(ctx);
  const payload = `{"auth_algo":${JSON.stringify(h.authAlgo)},"cert_url":${JSON.stringify(h.certUrl)},"transmission_id":${JSON.stringify(h.transmissionId)},"transmission_sig":${JSON.stringify(h.transmissionSig)},"transmission_time":${JSON.stringify(h.transmissionTime)},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`;
  const res = await doFetch(`${base(ctx)}/v1/notifications/verify-webhook-signature`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload }).catch(() => null);
  if (!res?.ok) return false;
  return ((await res.json().catch(() => ({}))) as { verification_status?: string }).verification_status === "SUCCESS";
}
