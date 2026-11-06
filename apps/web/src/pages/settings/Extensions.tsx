import { Fragment, useEffect, useState } from "react";
import { Button, Callout, EmptyState, Field, Panel, Segmented, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { CrewPanel } from "../../components/CrewPanel.js";
import { api } from "../../lib/api.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { useLoad } from "../../lib/useLoad.js";

type Tone = "ok" | "warn" | "bad" | "neutral";
export interface SettingsCard {
  title: string;
  description?: string;
  status: {
    route: string;
    chip?: { key: string; values: Record<string, { label: string; tone: Tone }> };
    rows?: Array<{ key: string; label: string; format?: "date" | "text" | "copy" }>;
    /** A strip of headline facts at the top of the card: a value with a smaller line under it. */
    facts?: Array<{ key: string; label: string; subKey?: string; mono?: boolean }>;
    /** Which optional features the owner has. `data[key]` is the list of included ids; each item can link to another card of the same extension. */
    features?: { key: string; title: string; items: Array<{ id: string; label: string; hint?: string; card?: string }> };
    /** Rows tucked into a "Technical details" disclosure. */
    details?: Array<{ key: string; label: string; format?: "date" | "text" | "copy" }>;
    /** `data[key]` is a list of setup steps: label, optional detail, and whether it is done, current or still to come. */
    steps?: { key: string };
    links?: Array<{ label: string; href: string; when?: { key: string; equals: string | boolean } }>;
    notice?: string;
    /** Key of a one-line text in the status data. Lets the Extensions page show the card collapsed. */
    summary?: string;
    /** Open on first sight even while healthy. The owner's own choice wins afterwards. */
    startOpen?: boolean;
    meters?: Array<{ key: string }>;
    stats?: Array<{ key: string; label: string; format?: "bytes" | "number" | "text"; hintKey?: string }>;
    charts?: Array<{ key: string; title: string; format?: "bytes" | "number" }>;
    lists?: Array<{ key: string; label: string; empty?: string; title: string; subtitle?: string; id?: string; removeRoute?: string; removeConfirm?: string }>;
    connection?: { show?: { key: string; equals: string | boolean }; titleKey: string; detailKey?: string; toneKey: string };
    toggles?: { title?: string; show?: { key: string; equals: string | boolean }; items: Array<{ key: string; label: string; hint?: string; route: string; confirmOn?: string }> };
  };
  actions: Array<{
    label: string;
    route: string;
    primary?: boolean;
    /** A quiet, red action for removing or releasing something. */
    danger?: boolean;
    inline?: boolean;
    collapsed?: { when: { key: string; equals: string | boolean }; editLabel?: string; prefillKey?: string };
    when?: { key: string; equals: string | boolean };
    fields?: Array<{ name: string; label: string; hint?: string; secret?: boolean; optionsKey?: string; optional?: boolean; savedKey?: string }>;
    confirm?: string;
  }>;
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
  crewPanelAt?: number;
}

const fmt = (v: unknown, format?: string) => {
  if (v === null || v === undefined || v === "") return "—";
  if (format === "date" && typeof v === "number") return new Date(v * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
  return String(v);
};

const openKey = (id: string, title: string) => `op.ext.open.${id}/${title}`;
export const cardAnchor = (id: string, title: string) => `ext-${`${id}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
const readOpen = (key: string): boolean | null => {
  try {
    const v = window.localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
};
const writeOpen = (key: string, on: boolean) => {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private mode: the card just won't remember */
  }
};

function CopyValue({ value }: { value: string }) {
  const toast = useToast();
  return (
    <span className="ext-copy">
      <code>{value}</code>
      <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast("Copied"), () => toast("Couldn't copy. Select it and copy by hand.")); }}>Copy</Button>
    </span>
  );
}
const cell = (v: unknown, format?: string) => (format === "copy" && typeof v === "string" && v ? <CopyValue value={v} /> : fmt(v, format === "copy" ? undefined : format));

type Step = { label: string; detail?: string; state: "done" | "now" | "todo" };

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
export function ExtensionCard({ id, card, vars = {}, collapsible = false, onTone }: { id: string; card: SettingsCard; vars?: Record<string, string>; collapsible?: boolean; onTone?: (tone: Tone | null) => void }) {
  const fill = (route: string) => route.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? encodeURIComponent(vars[k]!) : m));
  const toast = useToast();
  const base = `/extensions/${id}`;
  const { data, error, reload, setData } = useLoad<Record<string, unknown>>(`${base}${fill(card.status.route)}`);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // An action may answer with a `message` the owner needs to read, such as a one-time password. It stays until dismissed.
  const [resultNote, setResultNote] = useState<string | null>(null);
  // Which collapsed form is open for editing (an index into card.actions).
  const [editing, setEditing] = useState<number | null>(null);

  // While the extension is busy it asks to be re-read, so progress moves on its own.
  const refreshMs = typeof data?.refreshMs === "number" ? Math.max(1000, data.refreshMs) : null;
  useEffect(() => {
    if (!refreshMs) return;
    const t = window.setTimeout(reload, refreshMs);
    return () => window.clearTimeout(t);
  }, [refreshMs, data, reload]);

  const chip = data && card.status.chip ? card.status.chip.values[String(data[card.status.chip.key])] : undefined;
  const summary = data && card.status.summary && typeof data[card.status.summary] === "string" ? (data[card.status.summary] as string) : "";
  // A card that is healthy folds to one line. One that needs the owner (warn, bad, an error notice) stays open.
  const needsYou = !!chip && (chip.tone === "warn" || chip.tone === "bad");
  const canFold = collapsible && !!summary;
  const storeKey = openKey(id, card.title);
  const [pref, setPref] = useState<boolean | null>(() => readOpen(storeKey));
  const open = !canFold || (pref ?? (needsYou || card.status.startOpen === true));
  const toneNow = chip ? chip.tone : null;
  useEffect(() => { if (data) onTone?.(toneNow); }, [data, toneNow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!collapsible) return;
    const h = (e: Event) => {
      if ((e as CustomEvent<string>).detail === cardAnchor(id, card.title)) { setPref(true); writeOpen(storeKey, true); }
    };
    window.addEventListener("ext:open", h);
    return () => window.removeEventListener("ext:open", h);
  }, [collapsible, id, card.title, storeKey]);
  const fold = () => { const next = !open; setPref(next); writeOpen(storeKey, next); };
  const notice = data && card.status.notice ? data[card.status.notice] : null;
  const actions = card.actions.map((a, i) => ({ a, i })).filter(({ a }) => !a.when || (data && data[a.when.key] === a.when.equals));
  const conn = card.status.connection;
  const connShown = !!(data && conn && (!conn.show || data[conn.show.key] === conn.show.equals));
  const isCollapsed = (a: SettingsCard["actions"][number], i: number) => !!(data && a.collapsed && data[a.collapsed.when.key] === a.collapsed.when.equals && editing !== i);
  const openEdit = (i: number) => {
    const prefill = card.actions[i]?.collapsed?.prefillKey ? data?.[card.actions[i]!.collapsed!.prefillKey!] : null;
    setValues(prefill && typeof prefill === "object" ? Object.fromEntries(Object.entries(prefill as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])) : {});
    setRunError(null);
    setEditing(i);
  };
  const cancelEdit = () => {
    setEditing(null);
    setValues({});
    setRunError(null);
  };

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

  const flip = async (t: NonNullable<NonNullable<SettingsCard["status"]["toggles"]>["items"]>[number], on: boolean) => {
    if (on && t.confirmOn && !window.confirm(t.confirmOn)) return;
    setRunError(null);
    try {
      const r = await api<Record<string, unknown>>(`${base}${fill(t.route)}`, { method: "POST", body: { on } });
      setData((prev) => ({ ...(prev ?? {}), ...r }));
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
      setEditing(null);
      toast(`${action.label}: done`);
      reload();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setRunning(null);
    }
  };

  return (
    <div id={collapsible ? cardAnchor(id, card.title) : undefined} className={`ext-anchor${canFold && !open ? " ext-folded" : ""}`}>
    <Panel
      title={card.title}
      description={canFold && !open ? summary : card.description}
      actions={
        <div className="ext-head-actions">
          {chip ? <StatusChip tone={chip.tone}>{chip.label}</StatusChip> : null}
          {canFold ? <Button size="sm" onClick={fold} aria-expanded={open} aria-label={`${open ? "Collapse" : "Open"} ${card.title}`}>{open ? "Close" : "Open"}</Button> : null}
        </div>
      }
    >
      {error && !data ? <Callout tone="bad" title="Couldn't load this">{error}</Callout> : null}
      {!data && !error ? <Spinner label="Loading" /> : null}
      {data && open ? (
        <div className="stack">
          {typeof notice === "string" && notice ? <Callout tone="warn">{notice}</Callout> : null}
          {connShown && conn ? (
            <div className={`ext-conn ${data![conn.toneKey] === "bad" ? "bad" : "ok"}`}>
              <span className="ext-conn-icon" aria-hidden="true">{data![conn.toneKey] === "bad" ? "!" : "✓"}</span>
              <div className="ext-conn-text">
                <strong>{fmt(data![conn.titleKey])}</strong>
                {conn.detailKey && data![conn.detailKey] ? <span>{String(data![conn.detailKey])}</span> : null}
              </div>
              <div className="ext-conn-actions">
                {actions.filter(({ a }) => a.inline && !a.fields?.length).map(({ a, i }) => (
                  <Button key={i} size="sm" onClick={() => void go(i)} loading={running === i}>{a.label}</Button>
                ))}
                {actions.filter(({ a, i }) => a.collapsed && isCollapsed(a, i)).map(({ a, i }) => (
                  <Button key={i} size="sm" onClick={() => openEdit(i)}>{a.collapsed?.editLabel ?? "Edit"}</Button>
                ))}
              </div>
            </div>
          ) : null}
          {card.status.toggles && (!card.status.toggles.show || data[card.status.toggles.show.key] === card.status.toggles.show.equals) ? (
            <div className="ext-toggles">
              {card.status.toggles.title ? <h3 className="ext-list-title">{card.status.toggles.title}</h3> : null}
              {card.status.toggles.items.map((t) => (
                <SwitchRow key={t.key} checked={data[t.key] === true} onChange={(v) => void flip(t, v)} label={t.label} hint={t.hint} />
              ))}
            </div>
          ) : null}
          {card.status.facts && card.status.facts.some((f) => data[f.key]) ? (
            <div className="ext-facts">
              {card.status.facts.filter((f) => data[f.key]).map((f) => (
                <div key={f.key} className="ext-fact">
                  <span className="k">{f.label}</span>
                  <span className={`v${f.mono ? " mono" : ""}`}>{String(data[f.key])}</span>
                  {f.subKey && data[f.subKey] ? <span className="s">{String(data[f.subKey])}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          {card.status.steps && Array.isArray(data[card.status.steps.key]) ? (
            <ol className="ext-steps">
              {(data[card.status.steps.key] as Step[]).map((st, n) => (
                <li key={st.label} className={`s-${st.state}`} aria-current={st.state === "now" ? "step" : undefined}>
                  <span className="s-n" aria-hidden="true">{st.state === "done" ? "✓" : n + 1}</span>
                  <span className="s-t"><strong>{st.label}</strong>{st.detail ? <small>{st.detail}</small> : null}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {card.status.features && Array.isArray(data[card.status.features.key]) ? (() => {
            const have = new Set(data[card.status.features.key] as string[]);
            const items = card.status.features.items;
            const count = items.filter((i) => have.has(i.id)).length;
            return (
              <div>
                <h3 className="ext-list-title">{card.status.features.title} · {count} of {items.length}</h3>
                <div className="ext-feat">
                  {items.map((i) => {
                    const on = have.has(i.id);
                    const inner = <><span className="ic" aria-hidden="true">{on ? "✓" : "🔒"}</span><span><strong>{i.label}</strong>{i.hint ? <small>{i.hint}</small> : null}</span></>;
                    const a = i.card ? cardAnchor(id, i.card) : null;
                    return a && on ? (
                      <a key={i.id} className="on" href={`#${a}`} onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("ext:open", { detail: a })); window.setTimeout(() => document.getElementById(a)?.scrollIntoView({ behavior: "smooth", block: "start" }), 30); }}>{inner}</a>
                    ) : <span key={i.id} className={on ? "on" : "off"}>{inner}</span>;
                  })}
                </div>
              </div>
            );
          })() : null}
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
                  <dd>{cell(data[r.key], r.format)}</dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
          {card.status.details?.some((r) => data[r.key]) ? (
            <details className="ext-more">
              <summary>Technical details</summary>
              <dl className="kv">
                {card.status.details.filter((r) => data[r.key]).map((r) => (
                  <Fragment key={r.key}><dt>{r.label}</dt><dd>{cell(data[r.key], r.format)}</dd></Fragment>
                ))}
              </dl>
            </details>
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
          {card.status.links?.filter((l) => !l.when || data[l.when.key] === l.when.equals).length ? (
            <div className="form-actions">
              {card.status.links.filter((l) => !l.when || data[l.when.key] === l.when.equals).map((l) => (
                <a key={l.href} className="btn" href={l.href} target="_blank" rel="noreferrer noopener">{l.label} ↗</a>
              ))}
            </div>
          ) : null}
          {actions.filter(({ a, i }) => !(connShown && a.inline && !a.fields?.length) && !isCollapsed(a, i)).filter(({ a }) => a.fields?.length).map(({ a, i }) => (
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
                      <TextInput {...p} type={f.secret ? "password" : "text"} placeholder={f.secret && f.savedKey && data[f.savedKey] === true ? "Saved. Type to replace." : undefined} value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} autoComplete="off" spellCheck={false} />
                    )
                  }
                </Field>
              ))}
              <div className="span-2 form-actions">
                <Button variant={a.primary ? "primary" : undefined} className={a.danger ? "danger-quiet" : undefined} type="submit" loading={running === i}>{a.label}</Button>
                {a.collapsed && editing === i ? <Button type="button" onClick={cancelEdit}>Cancel</Button> : null}
              </div>
            </form>
          ))}
          {(() => {
            const buttons = actions.filter(({ a, i }) => !(connShown && a.inline && !a.fields?.length) && !isCollapsed(a, i)).filter(({ a }) => !a.fields?.length);
            return buttons.length ? (
              <div className="form-actions ext-btn-row">
                {buttons.map(({ a, i }) => (
                  <Button key={i} variant={a.primary ? "primary" : undefined} className={a.danger ? "danger-quiet push-right" : undefined} loading={running === i} onClick={() => void go(i)}>{a.label}</Button>
                ))}
              </div>
            ) : null;
          })()}
        </div>
      ) : null}
    </Panel>
    </div>
  );
}

/** Settings from optional extensions. The cards are described by the extensions; this page just draws them. */
export function ExtensionsSettingsPage() {
  const { data, error } = useLoad<{ extensions: ExtensionInfo[] }>("/extensions");
  const [tones, setTones] = useState<Record<string, Tone | null>>({});
  if (error && !data) return <Callout tone="bad" title="Couldn't load extensions">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;
  const cards = data.extensions.flatMap((e) => e.cards.map((c) => ({ id: e.id, card: c })));
  // Each extension's cards in order, with its crew panel drawn where it was registered among them.
  const items = data.extensions.flatMap((e) => {
    const list: Array<{ kind: "card"; id: string; card: SettingsCard } | { kind: "crew"; id: string; route: string }> = [];
    const crew = e.status === "loaded" && e.crewPanel ? { kind: "crew" as const, id: e.id, route: e.crewPanel } : null;
    const at = Math.min(e.crewPanelAt ?? e.cards.length, e.cards.length);
    e.cards.forEach((c, i) => {
      if (crew && i === at) list.push(crew);
      list.push({ kind: "card", id: e.id, card: c });
    });
    if (crew && at >= e.cards.length) list.push(crew);
    return list;
  });
  const failed = data.extensions.filter((e) => e.status === "failed");
  return (
    <div className="stack">
      {cards.length > 3 ? (
        <nav className="ext-jump" aria-label="Jump to a card">
          {cards.map(({ id, card }) => {
            const a = cardAnchor(id, card.title);
            const t = tones[a];
            return (
              <a key={a} href={`#${a}`} onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("ext:open", { detail: a })); window.setTimeout(() => document.getElementById(a)?.scrollIntoView({ behavior: "smooth", block: "start" }), 30); }}>
                <i className={t === "warn" || t === "bad" ? "w" : t === "ok" ? "" : "n"} aria-hidden="true" />
                {card.title}
              </a>
            );
          })}
        </nav>
      ) : null}
      {items.map((it) => it.kind === "crew" ? <CrewPanel key={`${it.id}/crew`} extId={it.id} route={it.route} /> : <ExtensionCard key={`${it.id}/${it.card.title}`} id={it.id} card={it.card} collapsible onTone={(t) => setTones((m) => (m[cardAnchor(it.id, it.card.title)] === t ? m : { ...m, [cardAnchor(it.id, it.card.title)]: t }))} />)}
      {failed.map((e) => <Callout key={e.id} tone="warn" title={`The “${e.id}” extension didn't load`}>{e.error}</Callout>)}
      {!cards.length && !failed.length ? <EmptyState icon="sparkle" title="No extensions installed">Extensions add optional features. Put one in the extensions folder of your config directory and restart.</EmptyState> : null}
    </div>
  );
}
