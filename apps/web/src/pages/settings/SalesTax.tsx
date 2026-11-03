import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { SwitchRow } from "../../components/SwitchRow.js";

interface Rate {
  id?: string;
  state: string;
  name: string;
  rateBps: number;
  registration: string;
  isDefault: boolean;
}

const US_STATES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];
const stateName = new Map(US_STATES);

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** The places the studio collects sales tax. Each quote or invoice picks one; one is the default. */
export function SalesTaxSettingsPage() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ rates: Rate[] }>("/money/tax-rates");
  const [editing, setEditing] = useState<{ index: number } | "new" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const rates = data?.rates ?? [];

  const persist = async (next: Rate[], message: string) => {
    setSaveError(null);
    try {
      await api("/money/tax-rates", { method: "PUT", body: { rates: next } });
      toast(message);
      reload();
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't save. Try again.");
      return false;
    }
  };

  const remove = (i: number) => {
    const next = rates.filter((_, n) => n !== i);
    return persist(next, "Removed. Quotes you already wrote keep their tax.");
  };
  const makeDefault = (i: number) => persist(rates.map((r, n) => ({ ...r, isDefault: n === i })), "Default changed");

  return (
    <div className="stack">
      <Panel
        title="Sales tax"
        description="Add each state or place you collect tax in. New quotes and invoices use your default, and you can switch it per document. Check your rates with a tax professional."
        actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>Add a place</Button> : null}
        flush
      >
        {error ? <div className="pad"><Callout tone="bad">{error}</Callout></div> : null}
        {saveError ? <div className="pad"><Callout tone="bad">{saveError}</Callout></div> : null}
        {loading && !data ? <div className="pad"><Spinner label="Loading" /></div> : null}
        {data && rates.length === 0 ? (
          <EmptyState icon="receipt" title="You aren't charging sales tax" action={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add your first state</Button> : undefined}>
            Add a state and its rate and tax is added to taxable lines on quotes and invoices. Skip this if you don't collect it.
          </EmptyState>
        ) : (
          <ul className="catalog-list">
            {rates.map((r, i) => (
              <li key={r.id ?? i}>
                <span className="cat-main">
                  <b>{r.state ? `${r.state}${stateName.get(r.state) ? ` · ${stateName.get(r.state)}` : ""}` : r.name}</b>
                  <small>{[r.name && r.state ? r.name : null, r.registration ? `Registration ${r.registration}` : null].filter(Boolean).join(" · ") || "No registration number"}</small>
                </span>
                {r.isDefault ? <StatusChip tone="ok">Default</StatusChip> : null}
                <b>{pct(r.rateBps)}</b>
                {owner ? (
                  <span className="cat-actions">
                    <Button size="sm" onClick={() => setEditing({ index: i })}>Edit</Button>
                    {!r.isDefault ? <Button size="sm" variant="ghost" onClick={() => makeDefault(i)}>Make default</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => remove(i)}>Remove</Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <RateDialog
        target={editing === null ? null : editing === "new" ? "new" : (rates[editing.index] ?? null)}
        first={rates.length === 0}
        onClose={() => setEditing(null)}
        onSave={async (r) => {
          const next = editing !== null && editing !== "new" ? rates.map((x, n) => (n === editing.index ? r : x)) : [...rates, r];
          const final = r.isDefault ? next.map((x) => ({ ...x, isDefault: x === r })) : next;
          if (await persist(final, "Saved")) setEditing(null);
        }}
      />
    </div>
  );
}

function RateDialog({ target, first, onClose, onSave }: { target: Rate | "new" | null; first: boolean; onClose: () => void; onSave: (r: Rate) => Promise<void> }) {
  const [state, setState] = useState("");
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [registration, setRegistration] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  useEffect(() => {
    if (!target) return;
    const t = target === "new" ? null : target;
    setState(t?.state ?? "");
    setName(t?.name ?? "");
    setRate(t ? String(t.rateBps / 100) : "");
    setRegistration(t?.registration ?? "");
    setIsDefault(t?.isDefault ?? first);
  }, [target, first]);
  const editing = target && target !== "new" ? target : null;
  const { busy, error, submit } = useSubmit(async () => {
    const n = Number(rate);
    if (rate.trim() === "" || !Number.isFinite(n) || n < 0 || n > 50) throw new Error("Enter the rate as a percentage, like 5.5.");
    const label = name.trim() || (stateName.get(state) ? `${stateName.get(state)} sales tax` : "");
    if (!state && !label) throw new Error("Pick a state or name this place.");
    await onSave({ id: editing?.id, state, name: label, rateBps: Math.round(n * 100), registration, isDefault });
    return true;
  });
  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={editing ? "Edit tax place" : "Add a place you collect tax"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="tax-form" type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="tax-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field label="State">
          {(p) => (
            <select {...p} className="input" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Other (name it below)</option>
              {US_STATES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Rate (%)" hint="For example 5.5">{(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
        <Field className="span-2" label="Name on quotes" hint="What clients see next to the tax amount. Leave blank to use the state name.">{(p) => <TextInput {...p} maxLength={100} placeholder="Maine sales tax" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field className="span-2" label="Registration number" hint="Optional. For your records; clients don't see it.">{(p) => <TextInput {...p} maxLength={60} value={registration} onChange={(e) => setRegistration(e.target.value)} />}</Field>
        <div className="span-2">
          <SwitchRow checked={isDefault} onChange={setIsDefault} label="Use this for new quotes and invoices" />
        </div>
      </form>
    </Dialog>
  );
}
