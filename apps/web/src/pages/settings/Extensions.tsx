import { Fragment, useState } from "react";
import { Button, Callout, EmptyState, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
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
    lists?: Array<{ key: string; label: string; empty?: string; title: string; subtitle?: string; id?: string; removeRoute?: string; removeConfirm?: string }>;
  };
  actions: Array<{ label: string; route: string; primary?: boolean; when?: { key: string; equals: string | boolean }; fields?: Array<{ name: string; label: string; hint?: string; secret?: boolean; optionsKey?: string; optional?: boolean }>; confirm?: string }>;
}
export interface ExtensionInfo {
  id: string;
  status: "loaded" | "failed";
  error?: string;
  cards: SettingsCard[];
  shootCards?: SettingsCard[];
}

const fmt = (v: unknown, format?: string) => {
  if (v === null || v === undefined || v === "") return "—";
  if (format === "date" && typeof v === "number") return new Date(v * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
  return String(v);
};

/** Draws a card an extension described. `vars` fills `{name}` placeholders in its routes, such as the shoot's id. */
export function ExtensionCard({ id, card, vars = {} }: { id: string; card: SettingsCard; vars?: Record<string, string> }) {
  const fill = (route: string) => route.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? encodeURIComponent(vars[k]!) : m));
  const toast = useToast();
  const base = `/extensions/${id}`;
  const { data, error, reload, setData } = useLoad<Record<string, unknown>>(`${base}${fill(card.status.route)}`);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

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
