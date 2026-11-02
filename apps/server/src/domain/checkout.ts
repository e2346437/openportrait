import { and, eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { paypal, paypalConfigured } from "../payments/paypal.js";
import { PaymentError, type PaymentProvider } from "../payments/provider.js";
import { requiredContract } from "./contracts.js";
import { DomainError, linkTo, newId, type ServiceContext } from "./context.js";
import { formatMoney } from "./money.js";
import { byToken, nextDueCents, paidOf, publicView, recordPayment, recordProcessorRefund } from "./orders.js";

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
  ctx.db.insert(paymentAttempt).values({ id: attemptId, orderId: o.id, provider: provider.id, providerOrderId, amountCents: cents }).run();
  return { approveUrl, amountLabel: formatMoney(cents, currency) };
}

/** Takes an approved payment and records it. Used when the client returns and when a webhook says it was approved. */
async function complete(ctx: ServiceContext, attempt: typeof paymentAttempt.$inferSelect) {
  if (attempt.status === "paid") return "paid" as const;
  const provider = providers.find((p) => p.id === attempt.provider);
  if (!provider) throw new DomainError("invalid", "Unknown payment provider.");
  const result = await wrap(() => provider.capture(ctx, attempt.providerOrderId));
  if (result.status === "pending") return "pending" as const;
  if (result.status === "failed") {
    ctx.db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, attempt.id)).run();
    throw new DomainError("payment_failed", "The payment didn't go through. You haven't been charged.", 402);
  }
  recordPayment(ctx, attempt.orderId, { amountCents: result.amountCents, method: attempt.provider as "paypal", note: result.payerEmail ? `PayPal: ${result.payerEmail}` : "PayPal" }, { provider: attempt.provider, providerRef: result.providerRef });
  ctx.db.update(paymentAttempt).set({ status: "paid" }).where(eq(paymentAttempt.id, attempt.id)).run();
  return "paid" as const;
}

/** The client came back from the processor. Only an attempt that belongs to this invoice can be completed through its link. */
export async function finishCheckout(ctx: ServiceContext, token: string, providerOrderId: string) {
  const o = byToken(ctx, token);
  const attempt = ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.providerOrderId, providerOrderId), eq(paymentAttempt.orderId, o.id))).get();
  if (!attempt) throw new DomainError("not_found", "We couldn't find that payment.", 404);
  const outcome = await complete(ctx, attempt);
  return { outcome, view: publicView(ctx, token) };
}

/** A verified processor event. Unknown or already-handled events do nothing. */
export async function handleWebhookEvent(ctx: ServiceContext, event: { event_type?: string; resource?: Record<string, unknown> }) {
  const r = (event.resource ?? {}) as { id?: string; custom_id?: string; amount?: { value?: string }; links?: Array<{ rel: string; href: string }> };
  const cents = Math.round(Number(r.amount?.value ?? 0) * 100);
  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED": {
      const attempt = r.id ? ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.provider, "paypal"), eq(paymentAttempt.providerOrderId, r.id))).get() : undefined;
      if (attempt) await complete(ctx, attempt);
      return;
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      const attempt = r.custom_id ? ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, r.custom_id)).get() : undefined;
      if (!attempt || !r.id || attempt.status === "paid") return;
      recordPayment(ctx, attempt.orderId, { amountCents: cents, method: "paypal", note: "PayPal" }, { provider: "paypal", providerRef: r.id });
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
