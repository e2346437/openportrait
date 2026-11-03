import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Panel, Spinner, StatusChip, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { RichTextEditor } from "../../components/RichTextEditor.js";

interface Item {
  id: string;
  kind: "package" | "item";
  name: string;
  description: string | null;
  priceCents: number;
  taxable: boolean;
  autoPrice: boolean;
  components: { itemId: string; quantity: number }[];
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
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useLoad<{ items: Item[] }>(`/catalog?archived=${showArchived}`);
  const cur = useLoad<MoneyState>("/money/settings").data?.currency ?? "USD";
  const state: CatalogState = { items: data?.items ?? [], cur, owner, reload };
  return (
    <div className="stack">
      <ProductsPanel {...state} showArchived={showArchived} setShowArchived={setShowArchived} loading={loading} error={error} />
      <PackagesPanel {...state} />
      <CouponsPanel />
      <MoneyPanel />
    </div>
  );
}

interface CatalogState {
  items: Item[];
  cur: string;
  owner: boolean;
  reload: () => void;
}

function useArchive(reload: () => void) {
  const toast = useToast();
  return async (i: Item) => {
    await api(`/catalog/${i.id}/archive`, { body: { archived: !i.archivedAt } });
    toast(i.archivedAt ? "Restored" : "Archived. Past quotes are unchanged.");
    reload();
  };
}

function ProductsPanel({ items, cur, owner, reload, showArchived, setShowArchived, loading, error }: CatalogState & { showArchived: boolean; setShowArchived: (v: boolean) => void; loading: boolean; error: string | null }) {
  const toast = useToast();
  const archive = useArchive(reload);
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const products = items.filter((i) => i.kind === "item");
  return (
    <Panel
      title="Products"
      description="The single things you sell: coverage hours, prints, an album, travel. Build packages from these below."
      actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>Add product</Button> : null}
      flush
    >
      {error ? <div className="pad"><Callout tone="bad">{error}</Callout></div> : null}
      {loading && items.length === 0 ? <div className="pad"><Spinner label="Loading" /></div> : null}
      {!loading && products.length === 0 ? (
        <EmptyState icon="receipt" title="No products yet" action={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add your first product</Button> : undefined}>
          Add what you sell one piece at a time, like “Coverage hour” or “8x10 print”. You can also type lines straight into a quote.
        </EmptyState>
      ) : (
        <ul className="catalog-list">
          {products.map((i) => (
            <li key={i.id} className={i.archivedAt ? "archived" : ""}>
              <span className="cat-main">
                <b>{i.name}</b>
                <small>{[i.taxable ? "taxable" : "not taxed", i.description].filter(Boolean).join(" · ")}</small>
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [taxable, setTaxable] = useState(true);
  useEffect(() => {
    if (!target) return;
    const t = target === "new" ? null : target;
    setName(t?.name ?? "");
    setDescription(t?.description ?? "");
    setPrice(t ? moneyInput(t.priceCents) : "");
    setTaxable(t?.taxable ?? true);
  }, [target]);
  const editing = target && target !== "new" ? target : null;
  const { busy, error, submit } = useSubmit(() => {
    const cents = parseMoney(price);
    if (cents === null || cents < 0) throw new Error("Enter a price like 250.00.");
    const body = { kind: "item", name, description: description || null, priceCents: cents, taxable };
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
      title={editing ? "Edit product" : "Add a product"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="item-form" type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="item-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field className="span-2" label="Name">{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field className="span-2" label="Description" hint="Optional. Shown on the quote.">{(p) => <TextArea {...p} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Field label="Price">{(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        <div className="field">
          <span className="label">Sales tax</span>
          <SwitchRow checked={taxable} onChange={setTaxable} label="Charge tax on this" />
        </div>
      </form>
    </Dialog>
  );
}

function PackagesPanel({ items, cur, owner, reload }: CatalogState) {
  const toast = useToast();
  const archive = useArchive(reload);
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const packages = items.filter((i) => i.kind === "package");
  const byId = new Map(items.map((i) => [i.id, i]));
  const activeProducts = items.filter((i) => i.kind === "item" && !i.archivedAt);
  return (
    <Panel
      title="Packages"
      description="Bundles built from your products, like “Wedding, 8 hours”. The price can follow the products or be your own."
      actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")} disabled={activeProducts.length === 0}>Build a package</Button> : null}
      flush
    >
      {packages.length === 0 ? (
        <EmptyState icon="receipt" title="No packages yet">
          {activeProducts.length === 0 ? "Add a product above first, then bundle products into packages." : "Pick products and quantities to make a package, and see the savings against buying them one by one."}
        </EmptyState>
      ) : (
        <ul className="catalog-list">
          {packages.map((i) => {
            const parts = i.components.map((c) => `${c.quantity > 1 ? `${c.quantity} × ` : ""}${byId.get(c.itemId)?.name ?? "Removed product"}`);
            return (
              <li key={i.id} className={i.archivedAt ? "archived" : ""}>
                <span className="cat-main">
                  <b>{i.name}</b>
                  <small>{[parts.join(", ") || "No products listed", i.autoPrice ? "price follows products" : "custom price", i.taxable ? "taxable" : "not taxed"].join(" · ")}</small>
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
            );
          })}
        </ul>
      )}
      <PackageDialog target={editing} products={activeProducts} cur={cur} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); toast("Saved"); }} />
    </Panel>
  );
}

function PackageDialog({ target, products, cur, onClose, onSaved }: { target: Item | "new" | null; products: Item[]; cur: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [auto, setAuto] = useState(true);
  const [price, setPrice] = useState("");
  const [taxable, setTaxable] = useState(true);
  useEffect(() => {
    if (!target) return;
    const t = target === "new" ? null : target;
    setName(t?.name ?? "");
    setDescription(t?.description ?? "");
    setQty(Object.fromEntries((t?.components ?? []).map((c) => [c.itemId, c.quantity])));
    setAuto(t ? t.autoPrice : true);
    setPrice(t ? moneyInput(t.priceCents) : "");
    setTaxable(t?.taxable ?? true);
  }, [target]);
  const editing = target && target !== "new" ? target : null;
  const chosen = products.filter((p) => (qty[p.id] ?? 0) > 0);
  const sum = chosen.reduce((n, p) => n + p.priceCents * (qty[p.id] ?? 0), 0);
  const custom = parseMoney(price);
  const savings = !auto && custom !== null && sum > custom ? sum - custom : 0;
  const { busy, error, submit } = useSubmit(() => {
    if (chosen.length === 0) throw new Error("Pick at least one product for the package.");
    const cents = auto ? 0 : custom;
    if (cents === null || cents < 0) throw new Error("Enter a price like 2500.00.");
    const body = { kind: "package", name, description: description || null, priceCents: cents, autoPrice: auto, taxable, components: chosen.map((p) => ({ itemId: p.id, quantity: qty[p.id] ?? 1 })) };
    return editing ? api(`/catalog/${editing.id}`, { method: "PATCH", body }) : api("/catalog", { body });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) onSaved();
  };
  const setQ = (id: string, n: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(99, n)) }));
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={editing ? "Edit package" : "Build a package"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="package-form" type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="package-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field className="span-2" label="Package name">{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field className="span-2" label="What's included" hint="Optional. Shown on the quote, along with the products.">{(p) => <TextArea {...p} rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <fieldset className="span-2 pkg-pick">
          <legend className="label">Products in this package</legend>
          {products.map((p) => {
            const n = qty[p.id] ?? 0;
            return (
              <div key={p.id} className={`pkg-row${n > 0 ? " on" : ""}`}>
                <span className="cat-main"><b>{p.name}</b><small>{formatMoney(p.priceCents, cur)} each</small></span>
                <span className="pkg-step">
                  <Button size="sm" type="button" aria-label={`One fewer ${p.name}`} disabled={n === 0} onClick={() => setQ(p.id, n - 1)}>−</Button>
                  <output aria-label={`${p.name} quantity`}>{n}</output>
                  <Button size="sm" type="button" aria-label={`One more ${p.name}`} onClick={() => setQ(p.id, n + 1)}>+</Button>
                </span>
              </div>
            );
          })}
        </fieldset>
        <div className="span-2">
          <SwitchRow checked={auto} onChange={setAuto} label="Price follows the products" />
        </div>
        {auto ? (
          <p className="span-2 pkg-total">Price: <b>{formatMoney(sum, cur)}</b> <small>Updates if a product's price changes.</small></p>
        ) : (
          <>
            <Field label="Package price" hint={`Products add up to ${formatMoney(sum, cur)}.`}>{(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
            <p className="pkg-total">{savings > 0 ? <>Client saves <b>{formatMoney(savings, cur)}</b></> : null}</p>
          </>
        )}
        <div className="field span-2">
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
  const [f, setF] = useState({ currency: "USD", terms: "", paymentInstructions: "", quoteValidDays: "30" });
  useEffect(() => {
    if (data) setF({ currency: data.currency, terms: data.terms, paymentInstructions: data.paymentInstructions, quoteValidDays: String(data.quoteValidDays) });
  }, [data]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useSubmit(() => {
    return api("/money/settings", { method: "PUT", body: { currency: f.currency, terms: f.terms, paymentInstructions: f.paymentInstructions, quoteValidDays: Number(f.quoteValidDays) } });
  });
  if (error && !data) return <Callout tone="bad">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.submit()) !== undefined) toast("Saved");
  };
  return (
    <Panel title="Quotes and invoices" description="Defaults for every new quote and invoice. Sales tax rates live under Sales tax.">
      <form onSubmit={go} noValidate className="form-grid">
        {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
        <Field label="Currency" hint="A three-letter code, like USD." error={save.fieldErrors.currency}>{(p) => <TextInput {...p} maxLength={3} disabled={!owner} value={f.currency} onChange={set("currency")} />}</Field>
        <Field label="Quotes are good for (days)">{(p) => <TextInput {...p} inputMode="numeric" disabled={!owner} value={f.quoteValidDays} onChange={set("quoteValidDays")} />}</Field>
        <Field className="span-2" label="How clients can pay" hint="Shown on invoices. For example: Venmo @yourstudio, or checks to 12 Main St.">{(p) => <TextArea {...p} rows={2} maxLength={1000} disabled={!owner} value={f.paymentInstructions} onChange={set("paymentInstructions")} />}</Field>
        <div className="span-2 field">
          <span className="label" id="default-terms">Default terms and conditions</span>
          <RichTextEditor variant="standard" labelledBy="default-terms" disabled={!owner} value={f.terms} onChange={(html) => setF((x) => ({ ...x, terms: html }))} />
          <small className="hint">Copied onto each new quote. You can edit them per quote.</small>
        </div>
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
