export interface ReportRange {
  from: string;
  to: string;
}

export interface FinancialReport {
  range: ReportRange;
  currency: string;
  totals: {
    invoicedCents: number;
    taxInvoicedCents: number;
    collectedCents: number;
    refundedCents: number;
    netCollectedCents: number;
    invoiceCount: number;
    paymentCount: number;
    averageInvoiceCents: number;
  };
  outstanding: {
    totalCents: number;
    overdueCents: number;
    count: number;
    rows: Array<{ id: string; label: string; title: string; contactId: string; totalCents: number; paidCents: number; balanceCents: number; issuedOn: string; dueOn: string | null; daysOverdue: number }>;
  };
  byMonth: Array<{ month: string; invoicedCents: number; collectedCents: number; refundedCents: number }>;
  byMethod: Array<{ method: string; cents: number; count: number }>;
  byShootType: Array<{ id: string | null; name: string; invoicedCents: number; collectedCents: number; invoiceCount: number }>;
}

/** What an extension's report section answers with. Mirrors the server's ReportData. */
export interface ReportData {
  stats?: Array<{ label: string; value: number | string; format?: "money" | "number" | "text"; tone?: "ok" | "warn" | "bad" | "neutral"; hint?: string }>;
  bars?: Array<{ title: string; format?: "money" | "number"; rows: Array<{ label: string; value: number }> }>;
  tables?: Array<{
    title?: string;
    columns: Array<{ key: string; label: string; format?: "money" | "number" | "text"; align?: "start" | "end" }>;
    rows: Array<Record<string, string | number | null>>;
  }>;
  notice?: string;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Today's date (YYYY-MM-DD) in the studio's time zone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export type Preset = "month" | "last-month" | "quarter" | "year" | "last-year" | "custom";

export const presetLabels: Array<{ value: Preset; label: string }> = [
  { value: "month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "last-year", label: "Last year" },
  { value: "custom", label: "Custom" },
];

/** The date range a preset means, counted from `today`. */
export function rangeFor(preset: Exclude<Preset, "custom">, today: string): ReportRange {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastDay = (yy: number, mm: number) => ymd(new Date(Date.UTC(yy, mm, 0)));
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (preset) {
    case "month":
      return { from: first(y, m), to: today };
    case "last-month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: first(py, pm), to: lastDay(py, pm) };
    }
    case "quarter": {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: first(y, qm), to: today };
    }
    case "year":
      return { from: first(y, 1), to: today };
    case "last-year":
      return { from: first(y - 1, 1), to: `${y - 1}-12-31` };
  }
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export const methodLabel: Record<string, string> = { cash: "Cash", check: "Check", card: "Card", venmo: "Venmo", zelle: "Zelle", paypal: "PayPal", bank: "Bank transfer", credit: "Client credit", other: "Other" };
