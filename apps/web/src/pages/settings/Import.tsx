import { useRef, useState } from "react";
import { Button, Callout, Field, Icon, Panel, Segmented, Spinner, StatusChip, TextInput, useToast, type Tone } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";
import { SwitchRow } from "../../components/SwitchRow.js";

type Kind = "contacts" | "shoots" | "invoices";
interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
}
interface Row {
  line: number;
  action: "create" | "update" | "skip" | "error";
  label: string;
  notes: string[];
}
interface Report {
  applied: boolean;
  totalRows: number;
  counts: Record<Row["action"], number>;
  created: { contacts: number; shoots: number; shootTypes: number; invoices: number; payments: number };
  rows: Row[];
  truncated: boolean;
  headers: string[];
  mapping: Record<string, string>;
}

const KINDS: Array<{ value: Kind; label: string; help: string }> = [
  { value: "contacts", label: "Clients", help: "A list of clients with their name, email, phone and address." },
  { value: "shoots", label: "Shoots", help: "Shoots or projects, each with a name, date, type and client." },
  { value: "invoices", label: "Invoices and payments", help: "An income or payments report. Rows that share an order number become one invoice with several payments." },
];
const TONE: Record<Row["action"], Tone> = { create: "ok", update: "info", skip: "neutral", error: "bad" };
const WORD: Record<Row["action"], string> = { create: "Add", update: "Update", skip: "Skip", error: "Problem" };

/** One-time import of clients, shoots and invoices from files exported from another system. */
export function ImportSettingsPage() {
  const toast = useToast();
  const fields = useLoad<{ fields: Record<Kind, FieldDef[]> }>("/import/fields").data?.fields;
  const [kind, setKind] = useState<Kind>("contacts");
  const [source, setSource] = useState("Previous system");
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);
  const [update, setUpdate] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const reset = () => {
    setReport(null);
    setMapping(null);
    setError("");
  };

  const send = async (mode: "preview" | "commit", over: { text?: string; mapping?: Record<string, string> | null; kind?: Kind } = {}) => {
    const body = { kind: over.kind ?? kind, text: over.text ?? text, source, updateExisting: update, mapping: over.mapping === undefined ? (mapping ?? undefined) : (over.mapping ?? undefined) };
    setBusy(mode);
    setError("");
    try {
      const r = await api<Report>(`/import/${mode}`, { body });
      setReport(r);
      setMapping(r.mapping);
      if (mode === "commit") toast("Import finished");
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "The import failed.");
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const t = await file.text();
    setText(t);
    await send("preview", { text: t, mapping: null });
  };

  const defs = fields?.[kind] ?? [];
  const current = KINDS.find((k) => k.value === kind)!;
  const done = report?.applied;
  const writes = report ? report.counts.create + report.counts.update : 0;

  return (
    <div className="stack">
      <Panel title="Import your data" description="Bring clients, shoots and invoices from another system. Nothing is saved until you check the preview and press Import.">
        <div className="stack">
          <Segmented<Kind> label="What are you importing?" value={kind} onChange={(k) => { setKind(k); reset(); if (text) void send("preview", { kind: k, mapping: null }); }} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
          <p className="hint">{current.help}</p>
          <div className="grid-2">
            <Field label="Where is it from?" hint="Used to label what you import and to avoid importing the same row twice.">
              {(p) => <TextInput {...p} value={source} maxLength={60} onChange={(e) => { setSource(e.target.value); }} />}
            </Field>
            <Field label="File" hint="A CSV file, or a JSON file with a list of records.">
              {(p) => (
                <div className="row-gap">
                  <input {...p} ref={input} type="file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
                  <Button icon="inbox" onClick={() => input.current?.click()} loading={busy === "preview"}>{fileName ? "Choose another file" : "Choose a file"}</Button>
                  {fileName ? <small className="hint">{fileName}</small> : null}
                </div>
              )}
            </Field>
          </div>
          {kind === "contacts" ? <SwitchRow checked={update} onChange={(v) => { setUpdate(v); reset(); }} label="Update clients I already have" hint="Fills in blank details and adds tags and notes. Existing details are never overwritten." /> : null}
        </div>
      </Panel>

      <Panel title="Export your data" description="Download your clients, shoots and invoices as CSV files for a spreadsheet, your accountant, or a backup. They can be imported again here.">
        <div className="row-gap wrap">
          {KINDS.map((k) => (
            <a key={k.value} className="btn" href={`/api/studio/export/${k.value}.csv`} download>{k.label} (CSV)</a>
          ))}
        </div>
      </Panel>

      {error ? <Callout tone="bad" title="Couldn't read that file">{error}</Callout> : null}
      {busy === "preview" && !report ? <Spinner label="Reading your file" /> : null}

      {report && mapping ? (
        <>
          <Panel title="Match the columns" description="We guessed which column goes where. Change any that look wrong, then check the preview.">
            <details className="map-details" open={defs.some((f) => f.required && !mapping[f.key])}>
              <summary>{defs.filter((f) => mapping[f.key]).length} of {defs.length} columns matched. Review or change</summary>
            <div className="map-grid">
              {defs.map((f) => (
                <label key={f.key} className="map-row">
                  <span>
                    {f.label}
                    {f.required ? <b className="req"> *</b> : null}
                    {f.hint ? <small className="hint">{f.hint}</small> : null}
                  </span>
                  <select className="input" value={mapping[f.key] ?? ""} disabled={!!done} onChange={(e) => { const next = { ...mapping }; if (e.target.value) next[f.key] = e.target.value; else delete next[f.key]; setMapping(next); void send("preview", { mapping: next }); }}>
                    <option value="">Not in my file</option>
                    {report.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
              ))}
            </div>
            </details>
          </Panel>

          <Panel
            title={done ? "Import finished" : "Preview"}
            description={done ? "Here is what was saved." : "This is exactly what will happen. Nothing has been saved yet."}
            footer={
              done ? (
                <Button onClick={() => { setText(""); setFileName(""); reset(); }}>Import another file</Button>
              ) : (
                <div className="row-gap">
                  <Button variant="primary" icon="check" loading={busy === "commit"} disabled={writes === 0 || busy !== null} onClick={() => send("commit")}>
                    {writes ? `Import ${writes} ${writes === 1 ? "row" : "rows"}` : "Nothing to import"}
                  </Button>
                  {report.counts.error ? <small className="hint">Rows with a problem are left out. Fix them in the file and import again; rows already imported are skipped.</small> : null}
                </div>
              )
            }
            flush
          >
            <div className="pad row-gap wrap">
              <StatusChip tone="ok">{report.counts.create} to add</StatusChip>
              {report.counts.update ? <StatusChip tone="info">{report.counts.update} to update</StatusChip> : null}
              <StatusChip>{report.counts.skip} skipped</StatusChip>
              {report.counts.error ? <StatusChip tone="bad">{report.counts.error} with problems</StatusChip> : null}
              {report.created.shootTypes ? <StatusChip tone="info">{report.created.shootTypes} new shoot types</StatusChip> : null}
            </div>
            <ul className="import-rows">
              {report.rows.map((r) => (
                <li key={r.line}>
                  <StatusChip tone={TONE[r.action]}>{WORD[r.action]}</StatusChip>
                  <span className="cat-main">
                    <b>{r.label}</b>
                    <small>Line {r.line}{r.notes.length ? ` · ${r.notes.join(" ")}` : ""}</small>
                  </span>
                </li>
              ))}
            </ul>
            {report.truncated ? <p className="hint pad">Showing the first {report.rows.length} rows. All {report.totalRows} are included in the import.</p> : null}
          </Panel>
        </>
      ) : null}

      {!report && !error && busy === null ? (
        <Callout tone="info" title="Tips">
          <Icon name="info" /> Import clients first, then shoots, then invoices, so shoots and invoices find the right client. Run the same file twice and nothing is duplicated.
        </Callout>
      ) : null}
    </div>
  );
}
