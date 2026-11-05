import { Fragment, useEffect, useState } from "react";
import { Button, Callout, EmptyState, Field, Panel, Segmented, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";

type Tone = "ok" | "warn" | "bad" | "neutral";
export interface SettingsCard {
  title: string;
  description?: string;
  status: {
    route: string;
    chip?: { key: string; values: Record<string, { label: string; tone: Tone }> };
    rows?: Array<{ key: string; label: string; format?: "date" | "text" }>;
    notice?: string;
    meters?: Array<{ key: string }>;
    stats?: Array<{ key: string; label: string; format?: "bytes" | "number" | "text"; hintKey?: string }>;
    charts?: Array<{ key: string; title: string; format?: "bytes" | "number" }>;
    lists?: Array<{ key: string; label: string; empty?: string; title: string; subtitle?: string; id?: string; removeRoute?: string; removeConfirm?: string }>;
  };
  actions: Array<{ label: string; route: string; primary?: boolean; when?: { key: string; equals: string | boolean }; fields?: Array<{ name: string; label: string; hint?: string; secret?: boolean; optionsKey?: string; optional?: boolean }>; confirm?: string }>;
}
interface Meter { label: string; detail?: string; done: number; total: number; format?: "bytes" | "number"; tone?: Tone }
interface ChartData { views: Array<{ key: string; label: string; layout: "bars" | "columns"; points: Array<{ label: string; short?: string; value: number }>; note?: string }> }

export interface ExtensionInfo {
  id: string;
  status: "loaded" | "failed";
  error?: string;
  cards: SettingsCard[];
  reports?: Array<{ title: string; description?: string; route: string }>;
  shootCards?: SettingsCard[];
  crewPanel?: string;
}

const fmt = (v: unknown, format?: string) => {
  if (v === null || v === undefined || v === "") return "—";
  if (format === "date" && typeof v === "number") return new Date(v * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
  return String(v);
};

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const formatValue = (n: number, format?: string) => (format === "bytes" ? formatBytes(n) : n.toLocaleString());

function MeterBar({ m }: { m: Meter }) {
  const pct = m.total > 0 ? Math.min(100, Math.round((m.done / m.total) * 100)) : 0;
  return (
    <div className="ext-meter">
      <div className="ext-meter-head">
        <strong>{m.label}</strong>
        <span>{pct}% · {formatValue(m.done, m.format)} of {formatValue(m.total, m.format)}</span>
      </div>
      <div className={`ext-meter-track ${m.tone ?? "ok"}`} role="progressbar" aria-label={m.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {m.detail ? <small>{m.detail}</small> : null}
    </div>
  );
}

/** One series, so one color. Gallery view is a ranked bar list; time views are columns with the newest at the right. */
function CardChartView({ title, format, chart }: { title: string; format?: "bytes" | "number"; chart: ChartData }) {
  const [view, setView] = useState(chart.views[0]?.key ?? "");
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const v = chart.views.find((x) => x.key === view) ?? chart.views[0];
  if (!v) return null;
  const max = Math.max(1, ...v.points.map((p) => p.value));
  const total = v.points.reduce((a, p) => a + p.value, 0);
  const shown = hover !== null ? v.points[hover] : null;
  return (
    <div className="ext-chart">
      <div className="ext-chart-head">
        <h3 className="ext-list-title">{title}</h3>
        <Segmented value={v.key} onChange={(k) => { setView(k); setHover(null); }} label="Group by" options={chart.views.map((x) => ({ value: x.key, label: x.label }))} />
      </div>
      {v.points.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : table ? (
        <table className="ext-chart-table">
          <thead><tr><th>{v.label}</th><th>{format === "bytes" ? "Size" : "Count"}</th></tr></thead>
          <tbody>{v.points.map((p) => <tr key={p.label}><td>{p.label}</td><td>{formatValue(p.value, format)}</td></tr>)}</tbody>
        </table>
      ) : v.layout === "bars" ? (
        <ul className="bars">
          {v.points.map((p) => (
            <li key={p.label}>
              <span className="bar-label">{p.label}</span>
              <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${(p.value / max) * 100}%` }} /></span>
              <b className="bar-value">{formatValue(p.value, format)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="ext-chart-readout" aria-live="polite">{shown ? <><b>{shown.label}</b> · {formatValue(shown.value, format)}</> : <>Total shown · <b>{formatValue(total, format)}</b></>}</p>
          <div className="ext-cols" role="img" aria-label={`${title} by ${v.label}. Use the table view for exact numbers.`} onMouseLeave={() => setHover(null)}>
            {v.points.map((p, i) => (
              <button key={p.label} type="button" className={`ext-col${hover === i ? " on" : ""}`} title={`${p.label}: ${formatValue(p.value, format)}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                <span className="ext-col-plot"><span className="ext-col-bar" style={{ height: `${Math.max(2, (p.value / max) * 100)}%`, minHeight: 2 }} /></span>
                <span className="ext-col-label">{p.short ?? p.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {v.note ? <small className="muted">{v.note}</small> : null}
      {v.points.length ? <Button size="sm" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show as table"}</Button> : null}
    </div>
  );
}

/** Draws a card an extension described. `vars` fills `{name}` placeholders in its routes, such as the shoot's id. */
export function ExtensionCard({ id, card, vars = {} }: { id: string; card: SettingsCard; vars?: Record<string, string> }) {
  const fill = (route: string) => route.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? encodeURIComponent(vars[k]!) : m));
  const toast = useToast();
  const base = `/extensions/${id}`;
  const { data, error, reload, setData } = useLoad<Record<string, unknown>>(`${base}${fill(card.status.route)}`);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // An action may answer with a `message` the owner needs to read, such as a one-time password. It stays until dismissed.
  const [resultNote, setResultNote] = useState<string | null>(null);

  // While the extension is busy it asks to be re-read, so progress moves on its own.
  const refreshMs = typeof data?.refreshMs === "number" ? Math.max(1000, data.refreshMs) : null;
  useEffect(() => {
    if (!refreshMs) return;
    const t = window.setTimeout(reload, refreshMs);
    return () => window.clearTimeout(t);
  }, [refreshMs, data, reload]);

  const chip = data && card.status.chip ? card.status.chip.values[String(data[card.status.chip.key])] : undefined;
  const notice = data && card.status.notice ? data[card.status.notice] : null;
  const actions = card.actions.map((a, i) => ({ a, i })).filter(({ a }) => !a.when || (data && data[a.when.key] === a.when.equals));

  const remove = async (list: NonNullable<SettingsCard["status"]["lists"]>[number], itemId: string) => {
    if (list.removeConfirm && !window.confirm(list.removeConfirm)) return;
    setRunError(null);
    try {
      await api(`${base}${fill(list.removeRoute!).replace("%7Bid%7D", encodeURIComponent(itemId)).replace("{id}", encodeURIComponent(itemId))}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  const go = async (i: number) => {
    const action = card.actions[i]!;
    if (action.confirm && !window.confirm(action.confirm)) return;
    setRunning(i);
    setRunError(null);
    try {
      const body = Object.fromEntries((action.fields ?? []).map((f) => [f.name, values[f.name] ?? ""]));
      const r = await api<Record<string, unknown>>(`${base}${fill(action.route)}`, { method: "POST", body });
      // An action may answer with `openUrl` to send the owner to another page, such as a sign-in at a connected service.
      if (typeof r.openUrl === "string" && /^https:\/\/|^\//.test(r.openUrl)) {
        window.location.assign(r.openUrl);
        return;
      }
      setResultNote(typeof r.message === "string" && r.message ? r.message : null);
      setData((prev) => ({ ...(prev ?? {}), ...r }));
      setValues({});
      toast(`${action.label}: done`);
      reload();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setRunning(null);
    }
  };

  return (
    <Panel title={card.title} description={card.description} actions={chip ? <StatusChip tone={chip.tone}>{chip.label}</StatusChip> : undefined}>
      {error && !data ? <Callout tone="bad" title="Couldn't load this">{error}</Callout> : null}
      {!data && !error ? <Spinner label="Loading" /> : null}
      {data ? (
        <div className="stack">
          {typeof notice === "string" && notice ? <Callout tone="warn">{notice}</Callout> : null}
          {card.status.meters?.map((m) => {
            const v = data[m.key] as Meter | null | undefined;
            return v && typeof v === "object" ? <MeterBar key={m.key} m={v} /> : null;
          })}
          {card.status.stats?.length ? (
            <div className="stat-grid ext-stats">
              {card.status.stats.map((st) => {
                const raw = data[st.key];
                const hint = st.hintKey ? data[st.hintKey] : null;
                return (
                  <div key={st.key} className="stat">
                    <span className="stat-label">{st.label}</span>
                    <span className="stat-value">{typeof raw === "number" ? formatValue(raw, st.format) : fmt(raw)}</span>
                    {typeof hint === "string" && hint ? <small>{hint}</small> : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {card.status.rows?.length ? (
            <dl className="kv">
              {card.status.rows.map((r) => (
                <Fragment key={r.key}>
                  <dt>{r.label}</dt>
                  <dd>{fmt(data[r.key], r.format)}</dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
          {card.status.charts?.map((c) => {
            const chart = data[c.key] as ChartData | undefined;
            return chart && Array.isArray(chart.views) ? <CardChartView key={c.key} title={c.title} format={c.format} chart={chart} /> : null;
          })}
          {card.status.lists?.map((list) => {
            const items = Array.isArray(data[list.key]) ? (data[list.key] as Array<Record<string, unknown>>) : [];
            return (
              <div key={list.key} className="ext-list">
                <h3 className="ext-list-title">{list.label}</h3>
                {items.length ? (
                  <ul className="ext-list-items">
                    {items.map((it, n) => (
                      <li key={String(it[list.id ?? list.title] ?? n)}>
                        <span>
                          <strong>{String(it[list.title] ?? "")}</strong>
                          {list.subtitle && it[list.subtitle] ? <small>{String(it[list.subtitle])}</small> : null}
                        </span>
                        {list.removeRoute && list.id ? <Button size="sm" onClick={() => void remove(list, String(it[list.id!]))}>Remove</Button> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{list.empty ?? "Nothing here yet."}</p>
                )}
              </div>
            );
          })}
          {resultNote ? (
            <Callout tone="ok" title="Done">
              <p style={{ margin: 0, overflowWrap: "anywhere", userSelect: "all" }}>{resultNote}</p>
              <Button size="sm" onClick={() => setResultNote(null)}>Dismiss</Button>
            </Callout>
          ) : null}
          {runError ? <Callout tone="bad">{runError}</Callout> : null}
          {actions.map(({ a, i }) => (
            <form key={i} className="form-grid" noValidate onSubmit={(e) => { e.preventDefault(); void go(i); }}>
              {a.fields?.map((f) => (
                <Field key={f.name} label={f.label} hint={f.hint} className="span-2">
                  {(p) =>
                    f.optionsKey ? (
                      <select {...p} className="input" value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                        <option value="">{f.optional ? "None" : "Choose…"}</option>
                        {(Array.isArray(data[f.optionsKey]) ? (data[f.optionsKey] as Array<{ value: string; label: string }>) : []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <TextInput {...p} type={f.secret ? "password" : "text"} value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} autoComplete="off" spellCheck={false} />
                    )
                  }
                </Field>
              ))}
              <div className="span-2 form-actions">
                <Button variant={a.primary ? "primary" : undefined} type="submit" loading={running === i}>{a.label}</Button>
              </div>
            </form>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

/** Settings from optional extensions. The cards are described by the extensions; this page just draws them. */
export function ExtensionsSettingsPage() {
  const { data, error } = useLoad<{ extensions: ExtensionInfo[] }>("/extensions");
  if (error && !data) return <Callout tone="bad" title="Couldn't load extensions">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;
  const cards = data.extensions.flatMap((e) => e.cards.map((c) => ({ id: e.id, card: c })));
  const failed = data.extensions.filter((e) => e.status === "failed");
  return (
    <div className="stack">
      {cards.map(({ id, card }) => <ExtensionCard key={`${id}/${card.title}`} id={id} card={card} />)}
      {failed.map((e) => <Callout key={e.id} tone="warn" title={`The “${e.id}” extension didn't load`}>{e.error}</Callout>)}
      {!cards.length && !failed.length ? <EmptyState icon="sparkle" title="No extensions installed">Extensions add optional features. Put one in the extensions folder of your config directory and restart.</EmptyState> : null}
    </div>
  );
}
