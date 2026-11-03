import { randomUUID } from "node:crypto";
import { DomainError, type ServiceContext } from "./context.js";

/** One place the studio collects sales tax, such as a US state. */
export interface TaxRate {
  id: string;
  /** Short place code or name, like "ME". */
  state: string;
  /** What the client sees on the quote, like "Maine sales tax". */
  name: string;
  rateBps: number;
  /** The studio's registration or permit number. Not shown to clients. */
  registration: string;
  isDefault: boolean;
}

export interface TaxPick {
  id: string | null;
  label: string | null;
  bps: number;
}

export const LEGACY_RATE_ID = "default";

/** The studio's rates. A studio that only ever set the single rate gets it back as one default rate, so nothing needs migrating. */
export function listRates(ctx: ServiceContext): TaxRate[] {
  const stored = ctx.settings.get("money.taxRates");
  if (stored && stored.length > 0) return stored;
  const bps = ctx.settings.get("money.taxBps") ?? 0;
  return bps > 0 ? [{ id: LEGACY_RATE_ID, state: "", name: "Sales tax", rateBps: bps, registration: "", isDefault: true }] : [];
}

export function defaultRate(rates: TaxRate[]): TaxRate | undefined {
  return rates.find((r) => r.isDefault) ?? rates[0];
}

const label = (r: TaxRate) => r.name.trim() || (r.state ? `${r.state} sales tax` : "Sales tax");

/** Resolves the rate for a document. A rate id that no longer exists falls back to the default, never to a surprise zero. */
export function resolveRate(ctx: ServiceContext, id?: string | null): TaxPick {
  const rates = listRates(ctx);
  const r = (id ? rates.find((x) => x.id === id) : undefined) ?? defaultRate(rates);
  return r ? { id: r.id, label: label(r), bps: r.rateBps } : { id: null, label: null, bps: ctx.settings.get("money.taxBps") ?? 0 };
}

export interface TaxRateInput {
  id?: string;
  state: string;
  name: string;
  rateBps: number;
  registration?: string;
  isDefault?: boolean;
}

/** Saves the whole list. Exactly one rate is the default, and `money.taxBps` follows it so booking pages and older code keep working. */
export function saveRates(ctx: ServiceContext, input: TaxRateInput[]): TaxRate[] {
  if (input.length > 60) throw new DomainError("invalid", "That's too many places.");
  const rates: TaxRate[] = input.map((r) => {
    if (!Number.isInteger(r.rateBps) || r.rateBps < 0 || r.rateBps > 5000) throw new DomainError("invalid", "Enter each rate as a percentage from 0 to 50.");
    const state = r.state.trim().slice(0, 40);
    const name = r.name.trim().slice(0, 100);
    if (!state && !name) throw new DomainError("invalid", "Give each place a state or a name.");
    return { id: r.id && r.id !== LEGACY_RATE_ID ? r.id : randomUUID(), state, name, rateBps: r.rateBps, registration: (r.registration ?? "").trim().slice(0, 60), isDefault: !!r.isDefault };
  });
  const ids = new Set(rates.map((r) => r.id));
  if (ids.size !== rates.length) throw new DomainError("invalid", "Each place can only be listed once.");
  let seen = false;
  for (const r of rates) {
    if (r.isDefault && !seen) seen = true;
    else r.isDefault = false;
  }
  if (rates.length > 0 && !seen) rates[0]!.isDefault = true;
  ctx.settings.set("money.taxRates", rates);
  ctx.settings.set("money.taxBps", defaultRate(rates)?.rateBps ?? 0);
  return rates;
}
