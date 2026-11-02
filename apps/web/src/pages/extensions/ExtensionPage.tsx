import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, Callout, Dialog, EmptyState, Field, PageHeader, Spinner, Switch, TextArea, TextInput, useToast, type IconName } from "@openportrait/ui";
import { ApiError } from "../../lib/api.js";
import { extensionApi, useExtensionPages, type ExtensionPageDef, type PageColumn, type PageField } from "../../lib/extensionPages.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { useLoad } from "../../lib/useLoad.js";

type Row = { id: string } & Record<string, unknown>;
type Options = Array<{ value: string; label: string }>;
const ICONS = new Set<string>(["receipt", "pin", "note", "tag", "calendar", "camera", "folder", "image", "users", "clock", "globe", "building", "key", "sparkle", "heart", "send", "mail", "phone", "grid", "gear", "home", "inbox", "lan", "cloud", "shield", "lead", "palette", "crosshair"]);
const iconFor = (name?: string): IconName => (name && ICONS.has(name) ? (name as IconName) : "grid");

const qs = (def: ExtensionPageDef, value: string) => (def.filter && value ? `?${def.filter.name}=${encodeURIComponent(value)}` : "");

function cell(col: PageColumn, row: Row, currency: string): string {
  const v = row[col.key];
  if (v === null || v === undefined || v === "") return "—";
  if (col.format === "money") return formatMoney(Number(v), currency);
  if (col.format === "number") return `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${col.unit ? ` ${col.unit}` : ""}`;
  if (col.format === "date" && typeof v === "string") {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  return String(v);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function initialValues(fields: PageField[], row: Row | null): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const raw = row ? row[f.name] : f.default === "today" ? today() : f.default;
    if (f.type === "checkbox") out[f.name] = Boolean(raw);
    else if (raw === null || raw === undefined) out[f.name] = "";
    else if (f.type === "money" && row) out[f.name] = moneyInput(Number(raw));
    else out[f.name] = String(raw);
  }
  return out;
}

function toBody(fields: PageField[], values: Record<string, string | boolean>): { body: Record<string, unknown> } | { error: string; field: string } {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === "checkbox") body[f.name] = Boolean(v);
    else if (f.type === "money") {
      const cents = parseMoney(String(v));
      if (cents === null) return { error: "Enter an amount like 12.50.", field: f.name };
      body[f.name] = String(v).trim() === "" ? null : cents;
    } else if (f.type === "number") {
      const s = String(v).trim().replace(/,/g, "");
      if (s === "") body[f.name] = null;
      else if (!Number.isFinite(Number(s))) return { error: "Enter a number.", field: f.name };
      else body[f.name] = Number(s);
    } else body[f.name] = String(v).trim() === "" ? null : String(v).trim();
  }
  return { body };
}

function FieldControl({ field, value, onChange, error, extension }: { field: PageField; value: string | boolean; onChange: (v: string | boolean) => void; error?: string; extension: string }) {
  const remote = useLoad<{ options: Options }>(field.optionsRoute ? `/extensions/${extension}${field.optionsRoute}` : null);
  const options = field.options ?? remote.data?.options ?? [];
  if (field.type === "checkbox") {
    return (
      <div className={field.wide ? "span-2" : undefined}>
        <Switch checked={Boolean(value)} onChange={onChange} label={field.label} />
        {field.hint ? <span className="hint">{field.hint}</span> : null}
      </div>
    );
  }
  return (
    <Field label={field.required ? field.label : `${field.label} (optional)`} hint={field.hint} error={error} className={field.wide || field.type === "textarea" ? "span-2" : undefined}>
      {(p) =>
        field.type === "textarea" ? (
          <TextArea {...p} rows={3} value={String(value)} onChange={(e) => onChange(e.target.value)} />
        ) : field.type === "select" ? (
          <select {...p} className="input" value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {field.required ? null : <option value="">None</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <TextInput {...p} type={field.type === "date" ? "date" : "text"} inputMode={field.type === "money" || field.type === "number" ? "decimal" : undefined} value={String(value)} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Field>
  );
}

function RecordDialog({ extension, def, row, onClose, onSaved }: { extension: string; def: ExtensionPageDef; row: Row | "new"; onClose: () => void; onSaved: (msg: string) => void }) {
  const form = def.form!;
  const existing = row === "new" ? null : row;
  const [values, setValues] = useState(() => initialValues(form.fields, existing));
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  const save = async () => {
    const built = toBody(form.fields, values);
    if ("error" in built) return setError({ message: built.error, field: built.field });
    setBusy("save");
    setError(null);
    try {
      if (existing) await extensionApi(extension, `${form.item}/${existing.id}`, { method: "PATCH", body: built.body });
      else await extensionApi(extension, form.create, { method: "POST", body: built.body });
      onSaved(existing ? "Saved" : "Added");
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Couldn't save.", field: err instanceof ApiError ? err.field : undefined });
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!existing || !window.confirm("Delete this entry? This can't be undone.")) return;
    setBusy("delete");
    try {
      await extensionApi(extension, `${form.item}/${existing.id}`, { method: "DELETE" });
      onSaved("Deleted");
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Couldn't delete." });
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? "Edit entry" : form.title}
      footer={
        <>
          {existing ? (
            <Button variant="danger" icon="trash" loading={busy === "delete"} disabled={busy !== null} onClick={() => void remove()} style={{ marginRight: "auto" }}>
              Delete
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === "save"} disabled={busy !== null} onClick={() => void save()}>
            {existing ? "Save changes" : form.addLabel}
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && !form.fields.some((f) => f.name === error.field) ? (
          <div className="span-2">
            <Callout tone="bad">{error.message}</Callout>
          </div>
        ) : null}
        {form.fields.map((f) => (
          <FieldControl key={f.name} field={f} extension={extension} value={values[f.name] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} error={error?.field === f.name ? error.message : undefined} />
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function PageBody({ extension, def }: { extension: string; def: ExtensionPageDef }) {
  const toast = useToast();
  const money = useLoad<{ currency: string }>("/money/settings");
  const currency = money.data?.currency ?? "USD";
  const filterOpts = useLoad<{ options: Options; default?: string }>(def.filter ? `/extensions/${extension}${def.filter.optionsRoute}` : null);
  const [filterValue, setFilterValue] = useState<string | null>(null);
  const period = filterValue ?? filterOpts.data?.default ?? filterOpts.data?.options[0]?.value ?? "";
  const ready = !def.filter || filterOpts.data !== null;
  const query = qs(def, period);

  const list = useLoad<{ rows: Row[]; locked?: string }>(ready ? `/extensions/${extension}${def.list.route}${query}` : null);
  const summary = useLoad<Record<string, unknown> & { notice?: string; locked?: string }>(ready && def.summary ? `/extensions/${extension}${def.summary.route}${query}` : null);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const locked = list.data?.locked ?? summary.data?.locked;

  const reloadAll = () => {
    list.reload();
    summary.reload();
  };

  const header = <PageHeader title={def.title} description={def.description} actions={def.form && !locked ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>{def.form.addLabel}</Button> : undefined} />;

  if (locked) {
    return (
      <>
      {header}
      <EmptyState icon="key" title="Part of OpenPortrait Pro" action={<Link className="btn primary" to="/studio/settings/extensions">Open license settings</Link>}>
        {locked}
      </EmptyState>
      </>
    );
  }
  const rows = list.data?.rows ?? [];

  return (
    <>
      {header}
      {def.filter || def.export ? (
        <div className="toolbar ext-toolbar">
          {def.filter && filterOpts.data ? (
            <label className="ext-filter">
              <span>{def.filter.label}</span>
              <select className="input" value={period} onChange={(e) => setFilterValue(e.target.value)} aria-label={def.filter.label}>
                {filterOpts.data.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className="grow" />
          {def.export && rows.length ? (
            <a className="btn" href={`/api/studio/extensions/${extension}${def.export.route}${query}`} download>
              {def.export.label}
            </a>
          ) : null}
        </div>
      ) : null}

      {summary.data?.notice ? <Callout tone="warn">{summary.data.notice}</Callout> : null}
      {def.summary && summary.data ? (
        <div className="ext-tiles">
          {def.summary.tiles.map((t) => {
            const v = summary.data![t.key];
            return (
              <div key={t.key} className="ext-tile">
                <span>{t.label}</span>
                <b>{v === null || v === undefined ? "—" : t.format === "money" ? formatMoney(Number(v), currency) : t.format === "number" ? `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${t.unit ? ` ${t.unit}` : ""}` : String(v)}</b>
              </div>
            );
          })}
        </div>
      ) : null}

      {list.error && !list.data ? <Callout tone="bad" title="Couldn't load this">{list.error}</Callout> : null}
      {(list.loading && !list.data) || !ready ? <Spinner label="Loading" /> : null}
      {list.data && rows.length === 0 ? (
        <EmptyState icon={iconFor(def.icon)} title={def.list.empty.title} action={def.form ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>{def.form.addLabel}</Button> : undefined}>
          {def.list.empty.text}
        </EmptyState>
      ) : null}
      {rows.length ? (
        <div className="panel ext-table-wrap">
          <table className="doc-table ext-table">
            <thead>
              <tr>
                {def.list.columns.map((c) => (
                  <th key={c.key} className={c.format === "money" || c.format === "number" ? "num" : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={def.form ? "clickable" : undefined} onClick={def.form ? () => setEditing(r) : undefined}>
                  {def.list.columns.map((c, i) => (
                    <td key={c.key} data-label={c.label} className={c.format === "money" || c.format === "number" ? "num" : undefined}>
                      {i === 0 && def.form ? (
                        <button type="button" className="ext-link" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>
                          {cell(c, r, currency)}
                        </button>
                      ) : (
                        cell(c, r, currency)
                      )}
                      {c.sub && r[c.sub] ? <small>{String(r[c.sub])}</small> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editing && def.form ? (
        <RecordDialog
          extension={extension}
          def={def}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            toast(msg);
            reloadAll();
            filterOpts.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** A page an extension added to the sidebar, drawn from its description. */
export function ExtensionPageView() {
  const { extension = "", slug = "" } = useParams();
  const { pages, loading } = useExtensionPages();
  const found = pages.find((p) => p.extension === extension && p.page.slug === slug);
  if (!found) {
    if (loading) return <Spinner label="Loading" />;
    return (
      <EmptyState icon="grid" title="This page isn't available">
        The extension that provides it isn't installed or didn't load. <Link to="/studio/settings/extensions">Check extensions</Link>
      </EmptyState>
    );
  }
  return <PageBody key={`${extension}/${slug}`} extension={extension} def={found.page} />;
}
