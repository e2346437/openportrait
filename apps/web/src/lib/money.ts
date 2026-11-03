/** Money is whole cents everywhere; these convert to and from what people type and read. */

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** "1,250.50" or "$1250" to cents, or null when it isn't a number. Blank is zero. */
export function parseMoney(input: string): number | null {
  const s = input.replace(/[$,\s]/g, "");
  if (s === "") return 0;
  if (!/^-?\d*\.?\d{0,2}$/.test(s) || s === "." || s === "-") return null;
  return Math.round(Number(s) * 100);
}

/** Cents as a plain editable number, "1250.00". */
export const moneyInput = (cents: number): string => (cents / 100).toFixed(2);

export interface TotalLine {
  quantity: number;
  unitCents: number;
  taxable: boolean;
}

/** The same arithmetic the server uses, so the editor can show totals as you type. The server's numbers are the ones saved. */
export function totalsFor(lines: TotalLine[], discountCents: number, taxBps: number) {
  const subtotal = lines.reduce((n, l) => n + l.quantity * l.unitCents, 0);
  const taxableSub = lines.filter((l) => l.taxable).reduce((n, l) => n + l.quantity * l.unitCents, 0);
  const discount = Math.min(Math.max(0, discountCents), subtotal);
  const taxableDiscount = subtotal === 0 ? 0 : Math.round((discount * taxableSub) / subtotal);
  const tax = Math.round(((taxableSub - taxableDiscount) * taxBps) / 10_000);
  return { subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: subtotal - discount + tax };
}

export interface OrderSummary {
  id: string;
  kind: "quote" | "invoice";
  number: number | null;
  label: string;
  title: string;
  contactId: string;
  contactName: string;
  shootId: string | null;
  state: OrderState;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  validUntil: string | null;
  sentAt: string | number | null;
  createdAt: string | number;
}
export type OrderState = "draft" | "sent" | "expired" | "declined" | "void" | "unpaid" | "partial" | "paid";

export interface OrderDetail extends OrderSummary {
  intro: string | null;
  terms: string | null;
  subtotalCents: number;
  discountCents: number;
  couponCode: string | null;
  couponCents: number;
  creditAvailableCents?: number;
  taxCents: number;
  taxBps: number;
  taxRateId: string | null;
  taxLabel: string | null;
  contactEmail: string | null;
  acceptedName: string | null;
  acceptedAt: string | number | null;
  viewedAt: string | number | null;
  link: string;
  lines: Array<{ id: string; itemId: string | null; description: string; detail: string | null; quantity: number; unitCents: number; taxable: boolean }>;
  schedule: Array<{ id: string; label: string; amountCents: number; dueDate: string | null; paidCents: number; status: "paid" | "due" | "overdue" }>;
  payments: Array<{ id: string; amountCents: number; method: string; provider: string; note: string | null; paidAt: string | number }>;
}

export const stateLabel: Record<OrderState, string> = { draft: "Draft", sent: "Sent", expired: "Expired", declined: "Declined", void: "Void", unpaid: "Unpaid", partial: "Part paid", paid: "Paid" };
export const stateTone = (s: OrderState): "neutral" | "ok" | "warn" | "info" | "bad" => (s === "paid" ? "ok" : s === "partial" || s === "sent" ? "info" : s === "unpaid" || s === "expired" ? "warn" : s === "declined" || s === "void" ? "bad" : "neutral");
