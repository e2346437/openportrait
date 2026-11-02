/** Money is whole cents everywhere. These helpers keep rounding and display in one place. */

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Tax on a taxable amount, rounded to the nearest cent (half up). */
export function taxOn(taxableCents: number, bps: number): number {
  return Math.round((taxableCents * bps) / 10_000);
}

export interface LineInput {
  quantity: number;
  unitCents: number;
  taxable: boolean;
}

export interface Totals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Adds up lines. A discount is spread over taxable and untaxable lines in proportion, so tax is charged on what
 * the client actually pays.
 */
export function totalsFor(lines: LineInput[], discountCents: number, taxBps: number): Totals {
  const subtotal = lines.reduce((n, l) => n + l.quantity * l.unitCents, 0);
  const taxableSub = lines.filter((l) => l.taxable).reduce((n, l) => n + l.quantity * l.unitCents, 0);
  const discount = Math.min(Math.max(0, discountCents), subtotal);
  const taxableDiscount = subtotal === 0 ? 0 : Math.round((discount * taxableSub) / subtotal);
  const tax = taxOn(taxableSub - taxableDiscount, taxBps);
  return { subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: subtotal - discount + tax };
}
