import type { ServiceContext } from "../domain/context.js";

/** A payment processor. PayPal is first; others (Stripe, Square) implement the same shape. */
export interface PaymentProvider {
  id: string;
  name: string;
  /** Ready to take payments: credentials saved. */
  configured(ctx: Pick<ServiceContext, "settings">): boolean;
  /** Starts a checkout for an amount. The client is sent to `approveUrl`, then returns to `returnUrl`. */
  createCheckout(ctx: Pick<ServiceContext, "settings">, input: CheckoutInput): Promise<{ providerOrderId: string; approveUrl: string }>;
  /** Takes the money once the client has approved it. Safe to call again for the same checkout. */
  capture(ctx: Pick<ServiceContext, "settings">, providerOrderId: string): Promise<CaptureResult>;
}

export interface CheckoutInput {
  attemptId: string;
  amountCents: number;
  currency: string;
  description: string;
  studioName: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CaptureResult {
  status: "completed" | "pending" | "failed";
  amountCents: number;
  /** The processor's id for the money movement; used so the same payment is never recorded twice. */
  providerRef: string;
  payerEmail?: string;
}

/** A refusal from a processor, worded so the studio or client can act on it. */
export class PaymentError extends Error {}
