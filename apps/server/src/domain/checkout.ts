import { and, eq, notInArray } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { paypal, paypalConfigured } from "../payments/paypal.js";
import { PaymentError, type PaymentProvider } from "../payments/provider.js";
import { requiredContract } from "./contracts.js";
import { DomainError, linkTo, newId, type ServiceContext } from "./context.js";
import { formatMoney } from "./money.js";
import { byToken, flagPaymentForReview, nextDueCents, paidOf, publicView, recordPayment, recordProcessorRefund } from "./orders.js";

const { paymentAttempt, payment } = tables;

const providers: PaymentProvider[] = [paypal];

/** The processor clients can pay through: configured, and the studio has a public address to come back to. */
export function onlineProvider(ctx: ServiceContext): PaymentProvider | null {
  if (!(ctx.publicUrl?.() ?? "").startsWith("http")) return null;
  return providers.find((p) => p.configured(ctx)) ?? null;
}

const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof PaymentError) throw new DomainError("payment_failed", err.message, 502);
    throw err;
  }
};

/** What the client can pay online right now, or null. Shown on their invoice page. */
/** Stops payment until a required contract is signed. */
function assertSigned(ctx: ServiceContext, o: { requiredContractId: string | null }) {
  const c = requiredContract(ctx, o);
  if (c) throw new DomainError("contract_required", `Please sign ${c.title} before paying.`, 409);
}

export function onlineOptions(ctx: ServiceContext, token: string) {
  const o = byToken(ctx, token);
  const provider = onlineProvider(ctx);
  if (!provider || o.kind !== "invoice" || o.status !== "sent" || requiredContract(ctx, o)) return null;
  const due = nextDueCents(ctx, o);
  const balance = Math.max(0, o.totalCents - paidOf(ctx, o.id));
  return due > 0 ? { provider: provider.id, name: provider.name, dueCents: due, balanceCents: balance } : null;
}

/** Begins an online payment. Returns where to send the client to approve it. */
export async function startCheckout(ctx: ServiceContext, token: string, input: { amount: "due" | "balance" }) {
  const o = byToken(ctx, token);
  assertSigned(ctx, o);
  const provider = onlineProvider(ctx);
  if (!provider) throw new DomainError("not_available", "Online payment isn't available. Please pay another way.");
  if (o.kind !== "invoice" || o.status !== "sent") throw new DomainError("invalid", "This can't be paid right now.");
  const balance = Math.max(0, o.totalCents - paidOf(ctx, o.id));
  if (balance === 0) throw new DomainError("invalid", "This is already paid. Thank you!");
  const cents = input.amount === "balance" ? balance : nextDueCents(ctx, o);
  const currency = ctx.settings.get("money.currency") || "USD";
  const attemptId = newId();
  const { providerOrderId, approveUrl } = await wrap(() =>
    provider.createCheckout(ctx, {
      attemptId,
      amountCents: cents,
      currency,
      description: `${o.title} (${o.kind === "invoice" ? `Invoice ${o.invoiceNumber}` : "Quote"})`,
      studioName: ctx.settings.get("studio.name") ?? "",
      returnUrl: linkTo(ctx, `/o/${o.token}?pay=return`),
      cancelUrl: linkTo(ctx, `/o/${o.token}?pay=cancel`),
    }),
  );
  ctx.db.insert(paymentAttempt).values({ id: attemptId, orderId: o.id, provider: provider.id, providerOrderId, amountCents: cents, currency }).run();
  return { approveUrl, amountLabel: formatMoney(cents, currency) };
}

type Attempt = typeof paymentAttempt.$inferSelect;

/** Keeps processor-supplied text short and plain before it goes into a note. */
const clean = (v: unknown) => String(v ?? "").replace(/[^\w .:@/-]/g, "?").slice(0, 64);

/** "300.00" to 30000. Anything that isn't a plain decimal with at most two places is rejected, so the ledger never sees NaN or rounding. */
function parseCents(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** What the processor says it took, as read from a confirmed capture or a webhook. */
interface Report {
  ref: string;
  orderId: string;
  customId: string;
  amount: string;
  currency: string;
}

/** Why a report can't be matched to the attempt it claims to settle, or null when everything agrees. */
const LEGACY = "This checkout was started before its currency was stored, so it can't be checked automatically.";
function mismatch(attempt: Attempt, r: Report): string | null {
  if (!attempt.currency) return LEGACY;
  if (!r.ref) return "The processor didn't give a capture id.";
  if (r.orderId !== attempt.providerOrderId) return `The capture belongs to PayPal order ${clean(r.orderId) || "(none)"}, not ${clean(attempt.providerOrderId)}.`;
  if (r.customId !== attempt.id) return "The capture isn't tied to this checkout attempt.";
  const cents = parseCents(r.amount);
  if (cents === null) return "The reported amount wasn't a valid amount.";
  if (cents !== attempt.amountCents) return `The reported amount ${clean(r.amount)} doesn't match the ${(attempt.amountCents / 100).toFixed(2)} checkout.`;
  if (r.currency !== attempt.currency) return `The reported currency ${clean(r.currency) || "(none)"} doesn't match ${attempt.currency}.`;
  return null;
}

/** The outcome an attempt already reached, read fresh, for callers that lost a race to a settled or held attempt. */
function settledOutcome(ctx: ServiceContext, id: string) {
  const now = ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id)).get();
  return now?.status === "paid" ? ("paid" as const) : ("review" as const);
}

/** Leaves ledger and paid status alone, remembers why, and tells the studio. A capture may already have happened at the processor. */
function holdForReview(ctx: ServiceContext, attempt: Attempt, reason: string, ref?: string) {
  const note = ref ? `${reason} Capture ${clean(ref)}. A capture may have been taken at PayPal.` : `${reason} Nothing was captured by OpenPortrait.`;
  // Only an unsettled attempt can be held: a verified capture that already settled it, or an earlier hold, stands.
  const res = ctx.db.update(paymentAttempt).set({ status: "review", reviewNote: note }).where(and(eq(paymentAttempt.id, attempt.id), notInArray(paymentAttempt.status, ["paid", "review"]))).run();
  if (res.changes === 0) return settledOutcome(ctx, attempt.id);
  flagPaymentForReview(ctx, attempt.orderId, `PayPal order ${clean(attempt.providerOrderId)}: ${note}`);
  return "review" as const;
}

/** Takes an approved payment and records it. Used when the client returns and when a webhook says it was approved. */
async function complete(ctx: ServiceContext, attempt: Attempt) {
  if (attempt.status === "paid") return "paid" as const;
  if (attempt.status === "review") return "review" as const;
  const provider = providers.find((p) => p.id === attempt.provider);
  if (!provider) throw new DomainError("invalid", "Unknown payment provider.");
  // Without the original currency nothing PayPal reports can be verified, so don't take the money at all.
  if (!attempt.currency) return holdForReview(ctx, attempt, LEGACY);
  // Don't start a capture for an invoice that is no longer open (voided, for example). Money a processor already took is still recorded below.
  const o = ctx.db.select({ kind: tables.order.kind, status: tables.order.status }).from(tables.order).where(eq(tables.order.id, attempt.orderId)).get();
  if (!o || o.kind !== "invoice" || o.status !== "sent") {
    ctx.db.update(paymentAttempt).set({ status: "failed" }).where(and(eq(paymentAttempt.id, attempt.id), eq(paymentAttempt.status, "started"))).run();
    return "closed" as const;
  }
  let result: Awaited<ReturnType<typeof provider.capture>>;
  try {
    result = await wrap(() => provider.capture(ctx, attempt.providerOrderId));
  } catch (err) {
    // The capture request failed (PayPal unreachable, server error). If a webhook settled or held the attempt meanwhile, the client should hear that, not "couldn't reach PayPal".
    const now = ctx.db.select({ status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.id, attempt.id)).get();
    if (now?.status === "paid") return "paid" as const;
    if (now?.status === "review") return "review" as const;
    throw err;
  }
  // A webhook may have settled or held this attempt while the capture was in flight. Look again before writing anything.
  const fresh = ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attempt.id)).get() ?? attempt;
  if (fresh.status === "paid") return "paid" as const;
  if (fresh.status === "review") return "review" as const;
  if (result.status === "pending") return "pending" as const;
  if (result.status === "failed") {
    ctx.db.update(paymentAttempt).set({ status: "failed" }).where(and(eq(paymentAttempt.id, attempt.id), notInArray(paymentAttempt.status, ["paid", "review"]))).run();
    throw new DomainError("payment_failed", "The payment didn't go through. Please try again, or check PayPal before paying again.", 402);
  }
  const bad = mismatch(attempt, { ref: result.providerRef, orderId: result.orderId, customId: result.customId, amount: result.amount, currency: result.currency });
  if (bad) return holdForReview(ctx, attempt, bad, result.providerRef);
  recordPayment(ctx, attempt.orderId, { amountCents: parseCents(result.amount)!, method: attempt.provider as "paypal", note: result.payerEmail ? `PayPal: ${result.payerEmail}` : "PayPal" }, { provider: attempt.provider, providerRef: result.providerRef });
  ctx.db.update(paymentAttempt).set({ status: "paid" }).where(eq(paymentAttempt.id, attempt.id)).run();
  return "paid" as const;
}

/** The client came back from the processor. Only an attempt that belongs to this invoice can be completed through its link. */
export async function finishCheckout(ctx: ServiceContext, token: string, providerOrderId: string) {
  const o = byToken(ctx, token);
  const attempt = ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.providerOrderId, providerOrderId), eq(paymentAttempt.orderId, o.id))).get();
  if (!attempt) throw new DomainError("not_found", "We couldn't find that payment.", 404);
  const outcome = await complete(ctx, attempt);
  if (outcome === "closed") throw new DomainError("invoice_closed", "This invoice is no longer open for payment, so we didn't take a payment. If you were charged earlier, the studio will review it and be in touch.", 409);
  return { outcome, view: publicView(ctx, token) };
}

/** A verified processor event. Unknown or already-handled events do nothing. */
export async function handleWebhookEvent(ctx: ServiceContext, event: { event_type?: string; resource?: Record<string, unknown> }) {
  const r = (event.resource ?? {}) as { id?: string; status?: string; custom_id?: string; amount?: { value?: string; currency_code?: string }; links?: Array<{ rel: string; href: string }>; supplementary_data?: { related_ids?: { order_id?: string } } };
  const cents = Math.round(Number(r.amount?.value ?? 0) * 100);
  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED": {
      const attempt = r.id ? ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.provider, "paypal"), eq(paymentAttempt.providerOrderId, r.id))).get() : undefined;
      if (attempt) await complete(ctx, attempt);
      return;
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      const orderId = r.supplementary_data?.related_ids?.order_id ?? "";
      // PayPal's documented examples sometimes omit custom_id. Then the order id has to identify the attempt, and PayPal is asked to confirm.
      const attempt = r.custom_id
        ? ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, r.custom_id)).get()
        : orderId ? ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.provider, "paypal"), eq(paymentAttempt.providerOrderId, orderId))).get() : undefined;
      if (!attempt || !r.id || attempt.status === "paid" || attempt.status === "review") return;
      if (r.status !== "COMPLETED") return void holdForReview(ctx, attempt, `PayPal sent a completed-capture event with status ${clean(r.status) || "(none)"}.`, r.id);
      let customId = r.custom_id ?? "";
      if (!customId) {
        if (!attempt.currency) return void holdForReview(ctx, attempt, LEGACY, r.id);
        const found = await wrap(() => paypal.lookupCapture(ctx, attempt.providerOrderId, r.id!));
        // Anything may have changed while PayPal was being asked.
        const fresh = ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attempt.id)).get() ?? attempt;
        if (fresh.status === "paid" || fresh.status === "review") return;
        if (!found || found.providerRef !== r.id) return void holdForReview(ctx, attempt, "The event carried no attempt id and PayPal's order doesn't show this capture.", r.id);
        if (found.status !== "completed") return void holdForReview(ctx, attempt, "The event carried no attempt id and PayPal's order doesn't show this capture as completed.", r.id);
        const bad = mismatch(attempt, { ref: found.providerRef, orderId: found.orderId, customId: found.customId, amount: found.amount, currency: found.currency });
        if (bad) return void holdForReview(ctx, attempt, `PayPal's order lookup disagrees: ${bad}`, r.id);
        customId = found.customId;
      }
      const bad = mismatch(attempt, { ref: r.id, orderId, customId, amount: String(r.amount?.value ?? ""), currency: String(r.amount?.currency_code ?? "") });
      if (bad) return void holdForReview(ctx, attempt, bad, r.id);
      recordPayment(ctx, attempt.orderId, { amountCents: parseCents(r.amount?.value)!, method: "paypal", note: "PayPal" }, { provider: "paypal", providerRef: r.id });
      ctx.db.update(paymentAttempt).set({ status: "paid" }).where(eq(paymentAttempt.id, attempt.id)).run();
      return;
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      const captureId = r.links?.find((l) => l.rel === "up")?.href.split("/").pop();
      const original = captureId ? ctx.db.select().from(payment).where(and(eq(payment.provider, "paypal"), eq(payment.providerRef, captureId))).get() : undefined;
      if (original && r.id && cents > 0) recordProcessorRefund(ctx, original.orderId, { amountCents: cents, method: "paypal", provider: "paypal", providerRef: r.id });
      return;
    }
  }
}

export { paypalConfigured };
