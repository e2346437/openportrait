import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, Callout, Field, Icon, Panel, TextInput } from "@openportrait/ui";
import { ContactPicker, type PickedContact } from "../../components/ContactPicker.js";
import { api } from "../../lib/api.js";
import { formatMoney, moneyInput, parseMoney, totalsFor, type OrderDetail } from "../../lib/money.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { RichTextEditor } from "../../components/RichTextEditor.js";

interface CatalogItem {
  id: string;
  kind: "package" | "item";
  name: string;
  description: string | null;
  priceCents: number;
  taxable: boolean;
}
interface MoneySettings {
  currency: string;
  taxBps: number;
}
interface TaxRateRow {
  id: string;
  state: string;
  name: string;
  rateBps: number;
  isDefault: boolean;
}
interface FormLine {
  key: number;
  itemId: string | null;
  description: string;
  detail: string;
  quantity: string;
  price: string;
  taxable: boolean;
}
interface FormPay {
  key: number;
  label: string;
  amount: string;
  dueDate: string;
}

let keySeq = 1;
const blankLine = (): FormLine => ({ key: keySeq++, itemId: null, description: "", detail: "", quantity: "1", price: "", taxable: true });

/** Writing or editing a draft quote or invoice: who it's for, what's on it, and when payments are due. */
export function OrderEditor({ order, initialContact, initialShootId, onSaved }: { order: OrderDetail | null; initialContact?: PickedContact | null; initialShootId?: string | null; onSaved: (o: OrderDetail) => void }) {
  const catalog = useLoad<{ items: CatalogItem[] }>("/catalog");
  const settings = useLoad<MoneySettings>("/money/settings");
  const currency = settings.data?.currency ?? "USD";
  const rates = useLoad<{ rates: TaxRateRow[] }>("/money/tax-rates").data?.rates ?? [];
  const [taxRateId, setTaxRateId] = useState<string | null>(order?.taxRateId ?? null);
  const pickedRate = rates.find((r) => r.id === taxRateId) ?? rates.find((r) => r.isDefault) ?? rates[0];
  const taxBps = pickedRate ? pickedRate.rateBps : (settings.data?.taxBps ?? order?.taxBps ?? 0);

  const [kind, setKind] = useState<"quote" | "invoice">(order?.kind ?? "quote");
  const [contact, setContact] = useState<PickedContact | null>(order ? { id: order.contactId, name: order.contactName } : (initialContact ?? null));
  const [shootId, setShootId] = useState(order?.shootId ?? initialShootId ?? "");
  // Shoots this client is part of, so a quote can be filed under the right one and show up in reports by shoot type.
  const clientShoots = useLoad<{ shoots: Array<{ id: string; subject: string; shootType: string; startsAt: number | null }> }>(contact ? `/contacts/${contact.id}` : null).data?.shoots;
  const [title, setTitle] = useState(order?.title ?? "");
  const [intro, setIntro] = useState(order?.intro ?? "");
  const [terms, setTerms] = useState(order?.terms ?? "");
  const [validUntil, setValidUntil] = useState(order?.validUntil ?? "");
  const [discount, setDiscount] = useState(order && order.discountCents ? moneyInput(order.discountCents) : "");
  const [couponCode, setCouponCode] = useState(order?.couponCode ?? "");
  const couponList = useLoad<{ items: Array<{ id: string; code: string; kind: "percent" | "fixed"; value: number; itemId: string | null; active: boolean }> }>("/coupons").data?.items;
  const [lines, setLines] = useState<FormLine[]>(() =>
    order ? order.lines.map((l) => ({ key: keySeq++, itemId: l.itemId, description: l.description, detail: l.detail ?? "", quantity: String(l.quantity), price: moneyInput(l.unitCents), taxable: l.taxable })) : [blankLine()],
  );
  const split = order ? order.schedule.length > 1 : false;
  const [splitOn, setSplitOn] = useState(split);
  const [pays, setPays] = useState<FormPay[]>(() => (order && order.schedule.length > 1 ? order.schedule.map((s) => ({ key: keySeq++, label: s.label, amount: moneyInput(s.amountCents), dueDate: s.dueDate ?? "" })) : []));
  const [pickItem, setPickItem] = useState("");

  const parsed = useMemo(
    () => lines.map((l) => ({ quantity: Number(l.quantity), unit: parseMoney(l.price), taxable: l.taxable })),
    [lines],
  );
  const linesOk = parsed.every((p) => Number.isInteger(p.quantity) && p.quantity >= 1 && p.unit !== null);
  // A preview of the coupon, worked out the same way the server will. The server has the final say when you save.
  const couponCents = useMemo(() => {
    const c = couponList?.find((x) => x.code === couponCode.trim().toUpperCase().replace(/\s+/g, ""));
    if (!c) return 0;
    const eligible = lines.reduce((n, l, i) => n + (!c.itemId || l.itemId === c.itemId ? (Number.isInteger(parsed[i]!.quantity) ? parsed[i]!.quantity : 0) * (parsed[i]!.unit ?? 0) : 0), 0);
    return c.kind === "percent" ? Math.round((eligible * c.value) / 10_000) : Math.min(c.value, eligible);
  }, [couponList, couponCode, lines, parsed]);
  const totals = useMemo(() => totalsFor(parsed.map((p) => ({ quantity: Number.isInteger(p.quantity) ? p.quantity : 0, unitCents: p.unit ?? 0, taxable: p.taxable })), (parseMoney(discount) ?? 0) + couponCents, taxBps), [parsed, discount, couponCents, taxBps]);
  const paySum = pays.reduce((n, p) => n + (parseMoney(p.amount) ?? 0), 0);
  const payDiff = totals.totalCents - paySum;

  // Turning on payments starts with a retainer and a balance, which is what most studios want.
  useEffect(() => {
    if (splitOn && pays.length === 0) {
      const dep = Math.round(totals.totalCents * 0.3);
      setPays([
        { key: keySeq++, label: "Retainer", amount: moneyInput(dep), dueDate: "" },
        { key: keySeq++, label: "Balance", amount: moneyInput(totals.totalCents - dep), dueDate: "" },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitOn]);

  const setLine = (key: number, patch: Partial<FormLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addFromCatalog = (id: string) => {
    const item = catalog.data?.items.find((i) => i.id === id);
    if (!item) return;
    setLines((ls) => {
      const empty = ls.length === 1 && !ls[0]!.description && !ls[0]!.price;
      const line = { key: keySeq++, itemId: item.id, description: item.name, detail: item.description ?? "", quantity: "1", price: moneyInput(item.priceCents), taxable: item.taxable };
      return empty ? [line] : [...ls, line];
    });
    setPickItem("");
  };

  const save = useSubmit(async () => {
    if (!contact) throw new Error("Choose who this is for.");
    if (!linesOk) throw new Error("Check each line: a whole-number quantity and a price.");
    const discountCents = parseMoney(discount);
    if (discountCents === null) throw new Error("Enter the discount as an amount, like 50.00.");
    const body = {
      contactId: contact.id,
      shootId: shootId && clientShoots?.some((x) => x.id === shootId) ? shootId : null,
      title,
      intro: intro || null,
      terms,
      validUntil: validUntil || null,
      taxRateId: pickedRate?.id ?? null,
      discountCents,
      couponCode: couponCode.trim() || null,
      lines: lines.map((l, i) => ({ itemId: l.itemId, description: l.description, detail: l.detail || null, quantity: parsed[i]!.quantity, unitCents: parsed[i]!.unit!, taxable: l.taxable })),
      schedule: splitOn ? pays.map((p) => ({ label: p.label, amountCents: parseMoney(p.amount) ?? NaN, dueDate: p.dueDate || null })) : undefined,
    };
    return order ? api<OrderDetail>(`/orders/${order.id}`, { method: "PUT", body }) : api<OrderDetail>("/orders", { body: { kind, ...body } });
  });
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const o = await save.submit();
    if (o) onSaved(o);
  };
  const money = (c: number) => formatMoney(c, currency);

  return (
    <form onSubmit={onSubmit} noValidate className="stack order-form">
      {save.error ? <Callout tone="bad">{save.error}</Callout> : null}
      <Panel title={order ? "Details" : "New quote or invoice"} description={order ? undefined : "A quote becomes an invoice when the client accepts it. Choose Invoice to bill for work already agreed."}>
        <div className="form-grid">
          {!order ? (
            <div className="span-2 seg" role="radiogroup" aria-label="Type">
              {(["quote", "invoice"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                  {k === "quote" ? "Quote" : "Invoice"}
                </button>
              ))}
            </div>
          ) : null}
          <div className="span-2">
            <ContactPicker
              value={contact}
              onChange={(c) => {
                setContact(c);
                if (c?.id !== contact?.id) setShootId("");
              }}
              label="For"
            />
          </div>
          {clientShoots?.length ? (
            <Field className="span-2" label="Shoot" hint="Optional. Files this under the shoot, so it counts in reports for that type of shoot.">
              {(p) => (
                <select {...p} className="input" value={shootId} onChange={(e) => setShootId(e.target.value)}>
                  <option value="">Not tied to a shoot</option>
                  {clientShoots.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.subject} · {x.shootType}
                      {x.startsAt ? ` · ${new Date(x.startsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <Field className="span-2" label="Title" hint="What the client sees, such as “Smith wedding collection”." error={save.fieldErrors.title}>
            {(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <div className="span-2 field">
            <span className="label" id="order-intro">Introduction</span>
            <RichTextEditor variant="compact" labelledBy="order-intro" value={intro} onChange={setIntro} placeholder="Optional. A short note above the lines." />
          </div>
        </div>
      </Panel>

      <Panel
        title="What's included"
        actions={
          catalog.data?.items.length ? (
            <select className="input sm" aria-label="Add from your prices" value={pickItem} onChange={(e) => addFromCatalog(e.target.value)}>
              <option value="">Add from your prices…</option>
              {(["package", "item"] as const).map((k) => {
                const group = catalog.data!.items.filter((i) => i.kind === k);
                return group.length ? (
                  <optgroup key={k} label={k === "package" ? "Packages" : "Products"}>
                    {group.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} · {money(i.priceCents)}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          ) : null
        }
      >
        <ul className="line-list">
          {lines.map((l, i) => (
            <li key={l.key}>
              <div className="line-main">
                <Field label={i === 0 ? "Description" : "Description"} className="line-desc">
                  {(p) => <TextInput {...p} placeholder="Wedding collection, 8 hours" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />}
                </Field>
                <Field label="Qty" className="line-qty">
                  {(p) => <TextInput {...p} inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />}
                </Field>
                <Field label="Price each" className="line-price">
                  {(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} />}
                </Field>
                <div className="line-total" aria-label="Line total">
                  {money((parsed[i]!.unit ?? 0) * (Number.isInteger(parsed[i]!.quantity) ? parsed[i]!.quantity : 0))}
                </div>
              </div>
              <div className="line-extra">
                <TextInput aria-label="More detail" placeholder="More detail (optional)" value={l.detail} onChange={(e) => setLine(l.key, { detail: e.target.value })} />
                <label className="check-inline">
                  <input type="checkbox" checked={l.taxable} onChange={(e) => setLine(l.key, { taxable: e.target.checked })} /> Taxable
                </label>
                {lines.length > 1 ? (
                  <button type="button" className="btn sm ghost icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <Icon name="trash" />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <div>
          <Button type="button" icon="plus" size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            Add a line
          </Button>
        </div>
        <dl className="totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{money(totals.subtotalCents)}</dd>
          </div>
          <div className="discount-row">
            <dt>
              <label htmlFor="discount">Discount</label>
            </dt>
            <dd>
              <input id="discount" className="input sm" inputMode="decimal" placeholder="0.00" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </dd>
          </div>
          <div className="discount-row">
            <dt>
              <label htmlFor="coupon">Coupon code</label>
            </dt>
            <dd>
              <input id="coupon" className="input sm" autoCapitalize="characters" spellCheck={false} placeholder="Optional" value={couponCode} onChange={(e) => setCouponCode(e.target.value)} />
              {couponCents > 0 ? <small className="coupon-save">Takes off {money(couponCents)}</small> : null}
            </dd>
          </div>
          <div>
            <dt>
              {rates.length > 1 ? (
                <select className="input sm" aria-label="Tax place" value={pickedRate?.id ?? ""} onChange={(e) => setTaxRateId(e.target.value)}>
                  {rates.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.state || r.name} · {(r.rateBps / 100).toFixed(2).replace(/\.?0+$/, "") || "0"}%
                    </option>
                  ))}
                </select>
              ) : (
                <>Tax {taxBps ? `(${(taxBps / 100).toFixed(2).replace(/\.?0+$/, "")}%)` : ""}</>
              )}
            </dt>
            <dd>{money(totals.taxCents)}</dd>
          </div>
          <div className="grand">
            <dt>Total</dt>
            <dd>{money(totals.totalCents)}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Payments" description="When money is due. Payments you record are applied to these in order.">
        <label className="check-inline">
          <input type="checkbox" checked={splitOn} onChange={(e) => setSplitOn(e.target.checked)} /> Split into a retainer and balance
        </label>
        {splitOn ? (
          <>
            <ul className="pay-list">
              {pays.map((p) => (
                <li key={p.key}>
                  <Field label="Name">{(f) => <TextInput {...f} value={p.label} onChange={(e) => setPays((ps) => ps.map((x) => (x.key === p.key ? { ...x, label: e.target.value } : x)))} />}</Field>
                  <Field label="Amount">{(f) => <TextInput {...f} inputMode="decimal" value={p.amount} onChange={(e) => setPays((ps) => ps.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x)))} />}</Field>
                  <Field label="Due" hint="Blank: on acceptance">{(f) => <TextInput {...f} type="date" value={p.dueDate} onChange={(e) => setPays((ps) => ps.map((x) => (x.key === p.key ? { ...x, dueDate: e.target.value } : x)))} />}</Field>
                  {pays.length > 2 ? (
                    <button type="button" className="btn sm ghost icon" aria-label={`Remove ${p.label || "payment"}`} onClick={() => setPays((ps) => ps.filter((x) => x.key !== p.key))}>
                      <Icon name="trash" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="pay-foot">
              <Button type="button" size="sm" icon="plus" onClick={() => setPays((ps) => [...ps, { key: keySeq++, label: "", amount: "", dueDate: "" }])}>
                Add a payment
              </Button>
              <span className={payDiff === 0 ? "ok-text" : "bad-text"} role="status">
                {payDiff === 0 ? "Payments add up to the total." : payDiff > 0 ? `${money(payDiff)} not yet assigned to a payment.` : `${money(-payDiff)} more than the total.`}
              </span>
            </div>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            One payment of {money(totals.totalCents)}, due when {kind === "quote" ? "the quote is accepted" : "the invoice is sent"}.
          </p>
        )}
      </Panel>

      <Panel title="Terms">
        <div className="form-grid">
          {kind === "quote" ? (
            <Field label="Valid until" hint="Blank uses your default number of days.">
              {(p) => <TextInput {...p} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}
            </Field>
          ) : null}
          <div className="span-2 field">
            <span className="label" id="order-terms">Terms and conditions</span>
            <RichTextEditor variant="standard" labelledBy="order-terms" value={terms} onChange={setTerms} />
            <small className="hint">Shown at the bottom. Your default is in Settings &gt; Prices.</small>
          </div>
        </div>
      </Panel>

      <div className="form-actions sticky-actions">
        <Button variant="primary" type="submit" loading={save.busy}>
          {order ? "Save changes" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}
