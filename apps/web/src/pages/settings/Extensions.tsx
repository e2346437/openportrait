import { Fragment, useState } from "react";
import { Button, Callout, EmptyState, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";

type Tone = "ok" | "warn" | "bad" | "neutral";
export interface SettingsCard {
  title: string;
  description?: string;
  status: { route: string; chip?: { key: string; values: Record<string, { label: string; tone: Tone }> }; rows?: Array<{ key: string; label: string; format?: "date" | "text" }>; notice?: string };
  actions: Array<{ label: string; route: string; primary?: boolean; when?: { key: string; equals: string | boolean }; fields?: Array<{ name: string; label: string; hint?: string; secret?: boolean }>; confirm?: string }>;
}
export interface ExtensionInfo {
  id: string;
  status: "loaded" | "failed";
  error?: string;
  cards: SettingsCard[];
  reports?: Array<{ title: string; description?: string; route: string }>;
}

const fmt = (v: unknown, format?: string) => {
  if (v === null || v === undefined || v === "") return "—";
  if (format === "date" && typeof v === "number") return new Date(v * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
  return String(v);
};

function Card({ id, card }: { id: string; card: SettingsCard }) {
  const toast = useToast();
  const base = `/extensions/${id}`;
  const { data, error, reload, setData } = useLoad<Record<string, unknown>>(`${base}${card.status.route}`);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const chip = data && card.status.chip ? card.status.chip.values[String(data[card.status.chip.key])] : undefined;
  const notice = data && card.status.notice ? data[card.status.notice] : null;
  const actions = card.actions.map((a, i) => ({ a, i })).filter(({ a }) => !a.when || (data && data[a.when.key] === a.when.equals));

  const go = async (i: number) => {
    const action = card.actions[i]!;
    if (action.confirm && !window.confirm(action.confirm)) return;
    setRunning(i);
    setRunError(null);
    try {
      const body = Object.fromEntries((action.fields ?? []).map((f) => [f.name, values[f.name] ?? ""]));
      const r = await api<Record<string, unknown>>(`${base}${action.route}`, { method: "POST", body });
      // An action may answer with `openUrl` to send the owner to another page, such as a sign-in at a connected service.
      if (typeof r.openUrl === "string" && /^https:\/\/|^\//.test(r.openUrl)) {
        window.location.assign(r.openUrl);
        return;
      }
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
          {runError ? <Callout tone="bad">{runError}</Callout> : null}
          {actions.map(({ a, i }) => (
            <form key={i} className="form-grid" noValidate onSubmit={(e) => { e.preventDefault(); void go(i); }}>
              {a.fields?.map((f) => (
                <Field key={f.name} label={f.label} hint={f.hint} className="span-2">
                  {(p) => <TextInput {...p} type={f.secret ? "password" : "text"} value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} autoComplete="off" spellCheck={false} />}
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
      {cards.map(({ id, card }) => <Card key={`${id}/${card.title}`} id={id} card={card} />)}
      {failed.map((e) => <Callout key={e.id} tone="warn" title={`The “${e.id}” extension didn't load`}>{e.error}</Callout>)}
      {!cards.length && !failed.length ? <EmptyState icon="sparkle" title="No extensions installed">Extensions add optional features. Put one in the extensions folder of your config directory and restart.</EmptyState> : null}
    </div>
  );
}
