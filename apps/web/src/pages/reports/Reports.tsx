import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Callout, EmptyState, Field, PageHeader, Panel, Segmented, Spinner, StatusChip, Tabs, TextInput } from "@openportrait/ui";
import { useSession } from "../../lib/session.js";
import { useLoad } from "../../lib/useLoad.js";
import { formatMoney } from "../../lib/money.js";
import { formatDate } from "../../lib/time.js";
import { methodLabel, monthLabel, presetLabels, rangeFor, todayIn, type FinancialReport, type Preset, type ReportData } from "../../lib/reports.js";
import type { ExtensionInfo } from "../settings/Extensions.js";

type Tone = "ok" | "warn" | "bad" | "neutral";

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <div className={`stat${tone && tone !== "neutral" ? ` ${tone}` : ""}`}>
      <span className="stat-label">{label}</span>
      <b className="stat-value">{value}</b>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

/** Horizontal bars sharing one scale. Values may be negative (a loss), drawn to the left of the axis. */
function Bars({ rows, format }: { rows: Array<{ label: string; value: number }>; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className={`bar-fill${r.value < 0 ? " neg" : ""}`} style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} />
          </span>
          <b className="bar-value">{format(r.value)}</b>
        </li>
      ))}
    </ul>
  );
}

function MonthChart({ data, money }: { data: FinancialReport["byMonth"]; money: (n: number) => string }) {
  const max = Math.max(1, ...data.flatMap((m) => [m.invoicedCents, m.collectedCents - m.refundedCents]));
  return (
    <div className="month-chart" role="img" aria-label="Invoiced and collected by month. The table below has the same numbers.">
      <div className="mc-scroll">
        <div className="mc-cols" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(44px, 1fr))` }}>
          {data.map((m) => {
            const net = Math.max(0, m.collectedCents - m.refundedCents);
            return (
              <div key={m.month} className="mc-col" title={`${monthLabel(m.month)}: invoiced ${money(m.invoicedCents)}, collected ${money(m.collectedCents - m.refundedCents)}`}>
                <div className="mc-bars">
                  <span className="mc-bar mc-inv" style={{ height: `${(m.invoicedCents / max) * 100}%` }} />
                  <span className="mc-bar mc-net" style={{ height: `${(net / max) * 100}%` }} />
                </div>
                <span className="mc-label">{monthLabel(m.month)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mc-legend" aria-hidden="true">
        <span><i className="sw sw-inv" />Invoiced</span>
        <span><i className="sw sw-net" />Collected</span>
      </div>
    </div>
  );
}

function ExtensionSection({ id, route, from, to, currency }: { id: string; route: string; from: string; to: string; currency: string }) {
  const { data, error, loading } = useLoad<ReportData>(`/extensions/${id}${route}?from=${from}&to=${to}`);
  const fmt = (v: unknown, f?: string) => (typeof v === "number" ? (f === "money" ? formatMoney(v, currency) : v.toLocaleString("en-US")) : v === null || v === undefined || v === "" ? "—" : String(v));
  if (error && !data) return <Callout tone="bad" title="Couldn't load this report">{error}</Callout>;
  if (!data) return loading ? <Spinner label="Loading" /> : null;
  return (
    <div className="stack">
      {data.notice ? <Callout tone="neutral">{data.notice}</Callout> : null}
      {data.stats?.length ? (
        <div className="stat-grid">
          {data.stats.map((s) => <Stat key={s.label} label={s.label} value={fmt(s.value, s.format)} hint={s.hint} tone={s.tone} />)}
        </div>
      ) : null}
      {data.bars?.map((b) => (
        <Panel key={b.title} title={b.title}>
          {b.rows.length ? <Bars rows={b.rows} format={(n) => fmt(n, b.format)} /> : <p className="muted">Nothing in this range.</p>}
        </Panel>
      ))}
      {data.tables?.map((t, i) => (
        <Panel key={t.title ?? i} title={t.title} flush>
          {t.rows.length ? (
            <div className="table-scroll">
              <table className="doc-table">
                <thead><tr>{t.columns.map((c) => <th key={c.key} className={c.align === "end" || c.format === "money" || c.format === "number" ? "num" : undefined}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {t.rows.map((r, ri) => (
                    <tr key={ri}>{t.columns.map((c) => <td key={c.key} className={c.align === "end" || c.format === "money" || c.format === "number" ? "num" : undefined}>{fmt(r[c.key], c.format)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted pad">Nothing in this range.</p>}
        </Panel>
      ))}
    </div>
  );
}

export function ReportsPage() {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const today = useMemo(() => todayIn(tz), [tz]);
  const [preset, setPreset] = useState<Preset>("year");
  const [custom, setCustom] = useState(() => rangeFor("year", today));
  const range = preset === "custom" ? custom : rangeFor(preset, today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to) && range.from <= range.to;
  const { data, error, loading } = useLoad<FinancialReport>(valid ? `/reports/financial?from=${range.from}&to=${range.to}` : null);
  const ext = useLoad<{ extensions: ExtensionInfo[] }>("/extensions");
  const sections = (ext.data?.extensions ?? []).flatMap((e) => (e.status === "loaded" ? (e.reports ?? []).map((r) => ({ key: `${e.id}${r.route}`, id: e.id, ...r })) : []));
  const [tab, setTab] = useState("income");
  const currency = data?.currency ?? "USD";
  const money = (n: number) => formatMoney(n, currency);
  const day = (ymd: string) => formatDate(Date.parse(`${ymd}T12:00:00Z`), "UTC", { month: "short", day: "numeric", year: "numeric" });
  const active = sections.find((s) => s.key === tab);

  const tabs = [
    { id: "income", label: "Income" },
    { id: "owed", label: "Outstanding", count: data?.outstanding.count },
    { id: "types", label: "By shoot type" },
    ...sections.map((s) => ({ id: s.key, label: s.title })),
  ];
  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Reports"
        description="What you've invoiced, what has come in, and what is still owed."
        actions={valid ? <a className="btn" href={`/api/studio/reports/payments.csv?from=${range.from}&to=${range.to}`} download>Download payments (CSV)</a> : undefined}
      />
      <div className="report-range">
        <Segmented value={preset} onChange={setPreset} label="Period" options={presetLabels} />
        {preset === "custom" ? (
          <div className="range-fields">
            <Field label="From">{(p) => <TextInput {...p} type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />}</Field>
            <Field label="To">{(p) => <TextInput {...p} type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />}</Field>
          </div>
        ) : (
          <span className="muted range-note">{day(range.from)} – {day(range.to)}</span>
        )}
      </div>
      {!valid ? <Callout tone="warn">Pick a start date that is on or before the end date.</Callout> : null}
      {error && !data ? <Callout tone="bad" title="Couldn't load reports">{error}</Callout> : null}
      {loading && !data && valid ? <Spinner label="Adding things up" /> : null}
      {data && t ? (
        <div className={loading ? "dim" : undefined}>
          <div className="stat-grid">
            <Stat label="Collected" value={money(t.netCollectedCents)} hint={t.refundedCents ? `after ${money(t.refundedCents)} refunded` : `${t.paymentCount} payment${t.paymentCount === 1 ? "" : "s"}`} tone="ok" />
            <Stat label="Invoiced" value={money(t.invoicedCents)} hint={`${t.invoiceCount} invoice${t.invoiceCount === 1 ? "" : "s"}${t.invoiceCount ? ` · avg ${money(t.averageInvoiceCents)}` : ""}`} />
            <Stat label="Still owed (today)" value={money(data.outstanding.totalCents)} hint={`${data.outstanding.count} invoice${data.outstanding.count === 1 ? "" : "s"}`} tone={data.outstanding.totalCents ? "warn" : undefined} />
            <Stat label="Overdue (today)" value={money(data.outstanding.overdueCents)} hint="past a due date" tone={data.outstanding.overdueCents ? "bad" : undefined} />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={tabs} label="Report" />
          <div className="report-body">
            {tab === "income" ? (
              <div className="stack">
                <Panel title="By month" description="Collected is money received that month (refunds subtracted). Invoiced is what you billed that month.">
                  {t.invoiceCount || t.paymentCount ? <MonthChart data={data.byMonth} money={money} /> : <EmptyState icon="chart" title="No income in this period">Try a wider date range, or record a payment on an invoice.</EmptyState>}
                </Panel>
                {t.invoiceCount || t.paymentCount ? (
                  <Panel title="Month by month" flush>
                    <div className="table-scroll">
                      <table className="doc-table">
                        <thead><tr><th>Month</th><th className="num">Invoiced</th><th className="num">Collected</th><th className="num">Refunded</th></tr></thead>
                        <tbody>
                          {data.byMonth.map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="num">{money(m.invoicedCents)}</td><td className="num">{money(m.collectedCents)}</td><td className="num">{m.refundedCents ? money(m.refundedCents) : "—"}</td></tr>)}
                        </tbody>
                        <tfoot><tr><th>Total</th><th className="num">{money(t.invoicedCents)}</th><th className="num">{money(t.collectedCents)}</th><th className="num">{t.refundedCents ? money(t.refundedCents) : "—"}</th></tr></tfoot>
                      </table>
                    </div>
                  </Panel>
                ) : null}
                {data.byMethod.length ? (
                  <Panel title="How clients paid">
                    <Bars rows={data.byMethod.map((m) => ({ label: `${methodLabel[m.method] ?? m.method}${m.count ? ` · ${m.count}` : ""}`, value: m.cents }))} format={money} />
                  </Panel>
                ) : null}
                {t.taxInvoicedCents ? <p className="muted">Sales tax included in what you invoiced: {money(t.taxInvoicedCents)}.</p> : null}
              </div>
            ) : null}
            {tab === "owed" ? (
              data.outstanding.rows.length ? (
                <Panel title="Unpaid invoices" description="A snapshot of today, whatever period is chosen above. Most overdue first." flush>
                  <div className="table-scroll">
                    <table className="doc-table">
                      <thead><tr><th>Invoice</th><th className="hide-sm">Issued</th><th>Due</th><th className="num">Total</th><th className="num">Owed</th></tr></thead>
                      <tbody>
                        {data.outstanding.rows.map((r) => (
                          <tr key={r.id}>
                            <td><Link to={`/studio/orders/${r.id}`}>{r.title}</Link><small>{r.label}</small></td>
                            <td className="hide-sm">{day(r.issuedOn)}</td>
                            <td>{r.dueOn ? day(r.dueOn) : "—"}{r.daysOverdue > 0 ? <> <StatusChip tone={r.dueOn ? "bad" : "warn"}>{r.daysOverdue} day{r.daysOverdue === 1 ? "" : "s"} {r.dueOn ? "overdue" : "old"}</StatusChip></> : null}</td>
                            <td className="num">{money(r.totalCents)}</td>
                            <td className="num"><b>{money(r.balanceCents)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              ) : <EmptyState icon="check" title="Nothing is owed">Every invoice you've sent is paid in full.</EmptyState>
            ) : null}
            {tab === "types" ? (
              data.byShootType.length ? (
                <div className="stack">
                  <Panel title="Collected by shoot type" description="Invoices are credited to the type of the shoot they are linked to.">
                    <Bars rows={data.byShootType.map((s) => ({ label: s.name, value: s.collectedCents }))} format={money} />
                  </Panel>
                  <Panel title="Details" flush>
                    <div className="table-scroll">
                      <table className="doc-table">
                        <thead><tr><th>Shoot type</th><th className="num">Invoices</th><th className="num">Invoiced</th><th className="num">Collected</th></tr></thead>
                        <tbody>{data.byShootType.map((s) => <tr key={s.id ?? "none"}><td>{s.name}</td><td className="num">{s.invoiceCount}</td><td className="num">{money(s.invoicedCents)}</td><td className="num">{money(s.collectedCents)}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </Panel>
                </div>
              ) : <EmptyState icon="camera" title="No income by shoot type yet">Link invoices to shoots and they'll be grouped here.</EmptyState>
            ) : null}
            {active ? (
              <div className="stack">
                {active.description ? <p className="muted">{active.description}</p> : null}
                <ExtensionSection key={`${active.key}${range.from}${range.to}`} id={active.id} route={active.route} from={range.from} to={range.to} currency={currency} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
