import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Panel, Spinner, StatusChip, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { SwitchRow } from "../../components/SwitchRow.js";

interface Item {
  id: string;
  kind: "package" | "item";
  name: string;
  description: string | null;
  priceCents: number;
  taxable: boolean;
  archivedAt: string | number | null;
}
interface MoneyState {
  currency: string;
  taxBps: number;
  terms: string;
  paymentInstructions: string;
  quoteValidDays: number;
}

/** What the studio sells, and how quotes and invoices are worded and taxed. */
export function PricesSettingsPage() {
  return (
    <div className="stack">
      <CatalogPanel />
      <CouponsPanel />
      <MoneyPanel />
    </div>
  );
}

function CatalogPanel() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useLoad<{ items: Item[] }>(`/catalog?archived=${showArchived}`);
  const cur = useLoad<MoneyState>("/money/settings").data?.currency ?? "USD";
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const items = data?.items ?? [];

  const archive = async (i: Item) => {
    await api(`/catalog/${i.id}/archive`, { body: { archived: !i.archivedAt } });
    toast(i.archivedAt ? "Restored" : "Archived. Past quotes are unchanged.");
    reload();
  };

  return (
    <Panel
      title="Packages and products"
      description="Your price list. Pick from it when you write a quote; each quote keeps its own copy of the price."
      actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>Add</Button> : null}
      flush
    >
      {error ? <div className="pad"><Callout tone="bad">{error}</Callout></div> : null}
      {loading && !data ? <div className="pad"><Spinner label="Loading" /></div> : null}
      {data && items.length === 0 ? (
        <EmptyState icon="receipt" title="No prices yet" action={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add your first package</Button> : undefined}>
          Add the packages and extras you sell, like “Wedding, 8 hours” or “Extra hour”. You can also type lines straight into a quote.
        </EmptyState>
      ) : (
        <ul className="catalog-list">
          {items.map((i) => (
            <li key={i.id} className={i.archivedAt ? "archived" : ""}>
              <span className="cat-main">
                <b>{i.name}</b>
                <small>{[i.kind === "package" ? "Package" : "Item", i.taxable ? "taxable" : "not taxed", i.description].filter(Boolean).join(" · ")}</small>
              </span>
              {i.archivedAt ? <StatusChip>Archived</StatusChip> : null}
              <b>{formatMoney(i.priceCents, cur)}</b>
              {owner ? (
                <span className="cat-actions">
                  <Button size="sm" onClick={() => setEditing(i)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => archive(i)}>{i.archivedAt ? "Restore" : "Archive"}</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="pad foot-row">
        <SwitchRow checked={showArchived} onChange={setShowArchived} label="Show archived" />
      </div>
      <ItemDialog target={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); toast("Saved"); }} />
    </Panel>
  );
}

function ItemDialog({ target, onClose, onSaved }: { target: Item | "new" | null; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<"package" | "item">("package");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [taxable, setTaxable] = useState(true);
  useEffect(() => {
    if (!target) return;
    const t = target === "new" ? null : target;
    setKind(t?.kind ?? "package");
    setName(t?.name ?? "");
    setDescription(t?.description ?? "");
    setPrice(t ? moneyInput(t.priceCents) : "");
    setTaxable(t?.taxable ?? true);
  }, [target]);
  const editing = target && target !== "new" ? target : null;
  const { busy, error, submit } = useSubmit(() => {
    const cents = parseMoney(price);
    if (cents === null || cents < 0) throw new Error("Enter a price like 250.00.");
    const body = { kind, name, description: description || null, priceCents: cents, taxable };
    return editing ? api(`/catalog/${editing.id}`, { method: "PATCH", body }) : api("/catalog", { body });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) onSaved();
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={editing ? "Edit price" : "Add to your price list"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="item-form" type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="item-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <div className="span-2 seg" role="radiogroup" aria-label="Type">
          {(["package", "item"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "package" ? "Package" : "Single item"}
            </button>
          ))}
        </div>
        <Field className="span-2" label="Name">{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field className="span-2" label="What's included" hint="Optional. Shown on the quote.">{(p) => <TextArea {...p} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Field label="Price">{(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        <div className="field">
          <span className="label">Sales tax</span>
          <SwitchRow checked={taxable} onChange={setTaxable} label="Charge tax on this" />
        </div>
      </form>
    </Dialog>
  );
}

function MoneyPanel() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const { data, error } = useLoad<MoneyState>("/money/settings");
  const [f, setF] = useState({ currency: "USD", tax: "0", terms: "", paymentInstructions: "", quoteValidDays: "30" });
  useEffect(() => {
    if (data) setF({ currency: data.currency, tax: String(data.taxBps / 100), terms: data.terms, paymentInstructions: data.paymentInstructions, quoteValidDays: String(data.quoteValidDays) });
  }, [data]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useSubmit(() => {
    const tax = Number(f.tax);
    if (!Number.isFinite(tax) || tax < 0 || tax > 50) throw new Error("Enter the tax rate as a percentage, like 8.25.");
    return api("/money/settings", { method: "PUT", body: { currency: f.currency, taxBps: Math.round(tax * 100), terms: f.terms, paymentInstructions: f.paymentInstructions, quoteValidDays: Number(f.quoteValidDays) } });
  });
  if (error && !data) return <Callout tone="bad">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.submit()) !== undefined) toast("Saved");
  };
  return (
    <Panel title="Quotes and invoices" description="Defaults for every new quote and invoice. Changing the tax rate doesn't change ones you've already written.">
      <form onSubmit={go} noValidate className="form-grid">
        {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
        <Field label="Currency" hint="A three-letter code, like USD." error={save.fieldErrors.currency}>{(p) => <TextInput {...p} maxLength={3} disabled={!owner} value={f.currency} onChange={set("currency")} />}</Field>
        <Field label="Sales tax rate (%)" hint="Added to taxable lines. Leave at 0 if you don't charge it.">{(p) => <TextInput {...p} inputMode="decimal" disabled={!owner} value={f.tax} onChange={set("tax")} />}</Field>
        <Field label="Quotes are good for (days)">{(p) => <TextInput {...p} inputMode="numeric" disabled={!owner} value={f.quoteValidDays} onChange={set("quoteValidDays")} />}</Field>
        <Field className="span-2" label="How clients can pay" hint="Shown on invoices. For example: Venmo @yourstudio, or checks to 12 Main St.">{(p) => <TextArea {...p} rows={2} maxLength={1000} disabled={!owner} value={f.paymentInstructions} onChange={set("paymentInstructions")} />}</Field>
        <Field className="span-2" label="Default terms and conditions" hint="Copied onto each new quote. You can edit them per quote.">{(p) => <TextArea {...p} rows={5} maxLength={6000} disabled={!owner} value={f.terms} onChange={set("terms")} />}</Field>
        {owner ? (
          <div className="span-2 form-actions">
            <Button variant="primary" type="submit" loading={save.busy}>Save</Button>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}

interface CouponRowData {
  id: string;
  code: string;
  description: string | null;
  kind: "percent" | "fixed";
  value: number;
  itemId: string | null;
  itemName: string | null;
  schedulerId: string | null;
  schedulerName: string | null;
  expiresOn: string | null;
  maxUses: number | null;
  uses: number;
  active: boolean;
  summary: string;
}

/** Discount codes. Apply one when writing a quote; it comes off the total and shows on the client's copy. */
function CouponsPanel() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ items: CouponRowData[] }>("/coupons");
  const [editing, setEditing] = useState<CouponRowData | "new" | null>(null);
  const items = data?.items ?? [];
  const remove = async (c: CouponRowData) => {
    const r = await api<{ removed: boolean }>(`/coupons/${c.id}`, { method: "DELETE" });
    toast(r.removed ? "Removed" : "It has been used, so it's switched off instead.");
    reload();
  };
  const note = (c: CouponRowData) => [c.description, c.expiresOn ? `expires ${c.expiresOn}` : null, `used ${c.uses}${c.maxUses ? ` of ${c.maxUses}` : ""} ${c.uses === 1 ? "time" : "times"}`].filter(Boolean).join(" · ");
  return (
    <Panel
      title="Coupon codes"
      description="Give a discount with a code, like SPRING25. Add it to a quote, or let clients type it on a sent quote or a booking page."
      actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>Add</Button> : null}
      flush
    >
      {error ? <div className="pad"><Callout tone="bad">{error}</Callout></div> : null}
      {loading && !data ? <div className="pad"><Spinner label="Loading" /></div> : null}
      {data && items.length === 0 ? (
        <EmptyState icon="receipt" title="No coupons yet" action={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Create a coupon</Button> : undefined}>
          Try 10% off a mini session, or $50 off for referrals. You can limit a code to one product, an expiry date, or a number of uses.
        </EmptyState>
      ) : (
        <ul className="catalog-list">
          {items.map((c) => (
            <li key={c.id} className={c.active ? "" : "archived"}>
              <span className="cat-main">
                <b>{c.code}</b>
                <small>{note(c)}</small>
              </span>
              {c.active ? null : <StatusChip>Off</StatusChip>}
              <b>{c.summary}</b>
              {owner ? (
                <span className="cat-actions">
                  <Button size="sm" onClick={() => setEditing(c)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(c)}>Remove</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <CouponDialog target={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); toast("Saved"); }} />
    </Panel>
  );
}

function CouponDialog({ target, onClose, onSaved }: { target: CouponRowData | "new" | null; onClose: () => void; onSaved: () => void }) {
  const cur = useLoad<MoneyState>("/money/settings").data?.currency ?? "USD";
  const items = useLoad<{ items: Item[] }>("/catalog?archived=false").data?.items ?? [];
  const pages = useLoad<{ items: Array<{ id: string; name: string }> }>("/schedulers").data?.items ?? [];
  const [f, setF] = useState({ code: "", description: "", kind: "percent" as "percent" | "fixed", value: "", itemId: "", schedulerId: "", expiresOn: "", maxUses: "", active: true });
  useEffect(() => {
    if (!target) return;
    const t = target === "new" ? null : target;
    setF({ code: t?.code ?? "", description: t?.description ?? "", kind: t?.kind ?? "percent", value: t ? (t.kind === "percent" ? String(t.value / 100) : moneyInput(t.value)) : "", itemId: t?.itemId ?? "", schedulerId: t?.schedulerId ?? "", expiresOn: t?.expiresOn ?? "", maxUses: t?.maxUses ? String(t.maxUses) : "", active: t?.active ?? true });
  }, [target]);
  const editing = target && target !== "new" ? target : null;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(() => {
    const n = f.kind === "percent" ? Number(f.value) : parseMoney(f.value);
    if (n === null || !Number.isFinite(n) || n <= 0) throw new Error(f.kind === "percent" ? "Enter the percentage, like 10." : "Enter the amount off, like 50.00.");
    const body = { code: f.code, description: f.description || null, kind: f.kind, value: f.kind === "percent" ? Math.round(n * 100) : n, itemId: f.itemId || null, schedulerId: f.schedulerId || null, expiresOn: f.expiresOn || null, maxUses: f.maxUses ? Number(f.maxUses) : null, active: f.active };
    return editing ? api(`/coupons/${editing.id}`, { method: "PUT", body }) : api("/coupons", { body });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) onSaved();
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={editing ? "Edit coupon" : "New coupon"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="coupon-form" type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="coupon-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field className="span-2" label="Code" hint="Letters and numbers. You can add it to a quote, or clients can type it on a quote or booking page.">{(p) => <TextInput {...p} autoFocus autoCapitalize="characters" spellCheck={false} value={f.code} onChange={set("code")} />}</Field>
        <div className="span-2 seg" role="radiogroup" aria-label="Type of discount">
          {(["percent", "fixed"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? "on" : ""} onClick={() => setF((x) => ({ ...x, kind: k }))}>
              {k === "percent" ? "Percent off" : `Amount off (${cur})`}
            </button>
          ))}
        </div>
        <Field label={f.kind === "percent" ? "Percent" : "Amount"}>{(p) => <TextInput {...p} inputMode="decimal" placeholder={f.kind === "percent" ? "10" : "50.00"} value={f.value} onChange={set("value")} />}</Field>
        <Field label="Only on" hint="Optional.">
          {(p) => (
            <select {...p} className="input" value={f.itemId} onChange={set("itemId")}>
              <option value="">Everything on the quote</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          )}
        </Field>
        <Field className="span-2" label="Works on" hint="Optional. Limit it to one booking page, such as a mini-session promotion.">
          {(p) => (
            <select {...p} className="input" value={f.schedulerId} onChange={set("schedulerId")}>
              <option value="">Quotes and all booking pages</option>
              {pages.map((i) => <option key={i.id} value={i.id}>Only on “{i.name}”</option>)}
            </select>
          )}
        </Field>
        <Field label="Last day" hint="Optional.">{(p) => <TextInput {...p} type="date" value={f.expiresOn} onChange={set("expiresOn")} />}</Field>
        <Field label="Use limit" hint="Optional. How many quotes can use it.">{(p) => <TextInput {...p} inputMode="numeric" value={f.maxUses} onChange={set("maxUses")} />}</Field>
        <Field className="span-2" label="Note to yourself" hint="Optional.">{(p) => <TextInput {...p} value={f.description} onChange={set("description")} />}</Field>
        <div className="span-2"><SwitchRow checked={f.active} onChange={(v) => setF((x) => ({ ...x, active: v }))} label="Active" /></div>
      </form>
    </Dialog>
  );
}
