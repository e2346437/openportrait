import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Callout, Dialog, Field, Panel, StatusChip, Switch, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { SHOOT_STATUS, type ShootDetail } from "../lib/types.js";
import { useSubmit } from "../lib/useForm.js";

const BILLING = {
  self: "Each person is billed on their own",
  parent: "One invoice to the organisation covers everyone",
} as const;

/** Group days: one shoot for a whole block of people (office headshots, a mini-session day), one child shoot per person or family. */
export function GroupDayPanel({ shoot, onChange }: { shoot: ShootDetail; onChange: (next: ShootDetail) => void | Promise<void> }) {
  const toast = useToast();
  const [pasting, setPasting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const convert = useSubmit(async () => {
    await api(`/shoots/${shoot.id}/group-day`, { method: "POST", body: {} });
    await onChange(await api<ShootDetail>(`/shoots/${shoot.id}`));
    toast("This shoot is now a group day");
  });
  const setBilling = async (billTo: "self" | "parent") => {
    try {
      await onChange(await api<ShootDetail>(`/shoots/${shoot.id}`, { method: "PATCH", body: { billTo } }));
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't save.", "bad");
    }
  };
  const add = useSubmit(async () => {
    const r = await api<{ child: { subject: string }; matched: boolean; duplicate: boolean; folderError: string | null }>(`/shoots/${shoot.id}/people`, { method: "POST", body: { name, email } });
    setName("");
    setEmail("");
    await onChange(await api<ShootDetail>(`/shoots/${shoot.id}`));
    toast(r.duplicate ? `${r.child.subject} was already on the list` : r.matched ? `${r.child.subject} added, matched to an existing client` : `${r.child.subject} added`);
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    await add.submit();
  };

  if (shoot.parent) return null;

  if (shoot.kind !== "group_day") {
    return (
      <Panel title="Group day" description="Photographing many people in one block, such as office headshots or a mini-session day? Give each person their own gallery and keep it all in one place.">
        {convert.error ? <Callout tone="bad">{convert.error}</Callout> : null}
        <Button icon="plus" loading={convert.busy} onClick={() => void convert.submit()}>
          Make this a group day
        </Button>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title={`People${shoot.children.length ? ` (${shoot.children.length})` : ""}`}
        description="Each person gets their own shoot, folder, and gallery."
        actions={
          <Button size="sm" onClick={() => setPasting(true)}>
            Paste a list
          </Button>
        }
      >
        {shoot.children.length === 0 ? (
          <p className="hint">Nobody yet. Add people below as they book or arrive, or paste a list of names and emails. You can also name people later from their photos.</p>
        ) : (
          <ul aria-label="People on this day" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
            {shoot.children.map((c) => (
              <li key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line, rgba(0,0,0,.08))" }}>
                <Link to={`/studio/shoots/${c.id}`} style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  <b>{c.subject}</b>
                  {c.email ? <small style={{ display: "block", opacity: 0.7 }}>{c.email}</small> : null}
                </Link>
                {!c.showOnMaster ? <StatusChip tone="neutral">Off master page</StatusChip> : null}
                <StatusChip tone={SHOOT_STATUS[c.status].tone}>{SHOOT_STATUS[c.status].label}</StatusChip>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={go} className="form-grid" noValidate style={{ marginTop: 12 }}>
          {add.error ? (
            <div className="span-2">
              <Callout tone="bad">{add.error}</Callout>
            </div>
          ) : null}
          <Field label="Name or family" hint="Or the family name for a mini session.">
            {(p) => <TextInput {...p} autoComplete="off" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Email" hint="Optional. A matching client is reused.">
            {(p) => <TextInput {...p} type="email" autoComplete="off" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <div className="form-actions span-2">
            <Button type="submit" variant="primary" icon="plus" loading={add.busy} disabled={!name.trim()}>
              Add person
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title="Billing" description="Who pays for this day. You can still give any one person their own invoice.">
        <Field label="Default for people on this day">
          {(p) => (
            <select {...p} className="input" value={shoot.billTo} onChange={(e) => void setBilling(e.target.value as "self" | "parent")}>
              {(Object.keys(BILLING) as Array<keyof typeof BILLING>).map((k) => (
                <option key={k} value={k}>
                  {BILLING[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className="hint">Applies to people you add from now on. Invoices for the day are created from the Orders panel.</p>
      </Panel>

      <PasteDialog open={pasting} shootId={shoot.id} onClose={() => setPasting(false)} onDone={async () => { setPasting(false); await onChange(await api<ShootDetail>(`/shoots/${shoot.id}`)); }} />
    </>
  );
}

/** Shown on a person's own shoot: where they sit in the day, and whether the organisation's page includes them. */
export function GroupDayMember({ shoot, onChange }: { shoot: ShootDetail; onChange: (next: ShootDetail) => void | Promise<void> }) {
  const toast = useToast();
  if (!shoot.parent) return null;
  const patch = async (body: Record<string, unknown>) => {
    try {
      await onChange(await api<ShootDetail>(`/shoots/${shoot.id}`, { method: "PATCH", body }));
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't save.", "bad");
    }
  };
  return (
    <Panel title="Group day" description={`Part of ${shoot.parent.subject}.`}>
      <p style={{ margin: "0 0 8px" }}>
        <Link to={`/studio/shoots/${shoot.parent.id}`}>Open {shoot.parent.subject}</Link>
      </p>
      <Switch label="Show on the organisation's page" checked={shoot.showOnMaster} onChange={(v) => void patch({ showOnMaster: v })} />
      <Field label="Billing">
        {(p) => (
          <select {...p} className="input" value={shoot.billTo} onChange={(e) => void patch({ billTo: e.target.value })}>
            {(Object.keys(BILLING) as Array<keyof typeof BILLING>).map((k) => (
              <option key={k} value={k}>
                {BILLING[k]}
              </option>
            ))}
          </select>
        )}
      </Field>
    </Panel>
  );
}

function PasteDialog({ open, shootId, onClose, onDone }: { open: boolean; shootId: string; onClose: () => void; onDone: () => void | Promise<void> }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ added: number; reused: number; duplicates: number; skipped: string[]; problems: string[] } | null>(null);
  const run = useSubmit(async () => {
    const r = await api<NonNullable<typeof result>>(`/shoots/${shootId}/people/import`, { method: "POST", body: { text } });
    setResult(r);
    if (!r.skipped.length && !r.problems.length) {
      toast(`${r.added} ${r.added === 1 ? "person" : "people"} added`);
      setText("");
      setResult(null);
      await onDone();
    }
  });
  const close = () => {
    const changed = result && result.added > 0;
    setText("");
    setResult(null);
    if (changed) void onDone();
    else onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Paste a list of people"
      description="One person per line: a name, then an email if you have one. Copying two columns from a spreadsheet works."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button variant="primary" loading={run.busy} disabled={!text.trim()} onClick={() => void run.submit()}>
            Add people
          </Button>
        </>
      }
    >
      <div className="stack">
        {run.error ? <Callout tone="bad">{run.error}</Callout> : null}
        {result ? (
          <Callout tone={result.skipped.length || result.problems.length ? "warn" : "ok"} title={`${result.added} added${result.reused ? `, ${result.reused} matched to existing clients` : ""}${result.duplicates ? `, ${result.duplicates} already on the list` : ""}`}>
            {[...result.skipped.map((s) => `Skipped: ${s}`), ...result.problems].join("\n")}
          </Callout>
        ) : null}
        <Field label="People">{(p) => <TextArea {...p} rows={8} value={text} placeholder={"Priya Nair, priya@example.com\nMarcus Webb, marcus@example.com"} onChange={(e) => setText(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
