import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Callout, CopyValue, Dialog, Field, Icon, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { formatMoney, moneyInput, parseMoney, stateLabel, stateTone, type OrderDetail } from "../../lib/money.js";
import { useSession } from "../../lib/session.js";
import { formatDate, ms } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { OrderEditor } from "./OrderEditor.js";
import type { PickedContact } from "../../components/ContactPicker.js";

const METHODS: Array<[string, string]> = [["credit", "Client credit"],["cash", "Cash"], ["check", "Check"], ["venmo", "Venmo"], ["zelle", "Zelle"], ["card", "Card"], ["bank", "Bank transfer"], ["paypal", "PayPal"], ["other", "Other"]];

/** One page for a quote or invoice: an editor while it's a draft, a record of what happened afterwards. */
export function OrderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isNew = !id;
  const { data, error, loading, setData, reload } = useLoad<OrderDetail>(id ? `/orders/${id}` : null);
  const preShoot = params.get("shoot");
  const shootLoad = useLoad<{ id: string; primary: { id: string; name: string } }>(isNew && preShoot ? `/shoots/${preShoot}` : null);
  const pre = params.get("contact") ?? shootLoad.data?.primary.id ?? null;
  const preContact = useLoad<{ id: string; name: string }>(isNew && pre ? `/contacts/${pre}` : null);
  const initial: PickedContact | null = preContact.data ? { id: preContact.data.id, name: preContact.data.name } : null;
  const [editing, setEditing] = useState(false);

  if (!isNew && loading && !data) return <Spinner label="Loading" />;
  if (!isNew && (error || !data)) return <Callout tone="bad" title="Couldn't open that">{error ?? "It may have been deleted."}</Callout>;
  if (isNew && ((pre && preContact.loading) || (preShoot && shootLoad.loading && !shootLoad.data))) return <Spinner label="Loading" />;

  const back = (
    <Link to="/studio/orders" className="back">
      <Icon name="arrowLeft" /> Orders
    </Link>
  );

  if (isNew)
    return (
      <div className="stack">
        {back}
        <h1 className="page-title">New quote or invoice</h1>
        <OrderEditor order={null} initialContact={initial} initialShootId={shootLoad.data?.id ?? null} onSaved={(o) => navigate(`/studio/orders/${o.id}`, { replace: true })} />
      </div>
    );

  const o = data!;
  if (o.state === "draft" || editing)
    return (
      <div className="stack">
        {back}
        <h1 className="page-title">
          {o.label}: edit draft
        </h1>
        <OrderEditor
          order={o}
          onSaved={(saved) => {
            setData(saved);
            setEditing(false);
          }}
        />
        {o.state === "draft" ? <DraftActions order={o} onChanged={reload} onSent={setData} /> : null}
      </div>
    );
  return (
    <div className="stack">
      {back}
      <OrderRecord order={o} onChanged={(x) => (x ? setData(x) : reload())} onEdit={() => setEditing(true)} />
    </div>
  );
}

function DraftActions({ order, onChanged, onSent }: { order: OrderDetail; onChanged: () => void; onSent: (o: OrderDetail) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const send = useSubmit(() => api<OrderDetail & { emailed: boolean }>(`/orders/${order.id}/send`, { method: "POST" }));
  const doSend = async () => {
    const r = await send.submit();
    if (!r) return;
    toast(r.emailed ? `Sent to ${order.contactName}.` : "Marked as sent. Email isn't set up, so copy the link and send it yourself.");
    onSent(r);
  };
  const del = async () => {
    if (!window.confirm("Delete this draft?")) return;
    await api(`/orders/${order.id}`, { method: "DELETE" });
    toast("Draft deleted");
    navigate("/studio/orders", { replace: true });
  };
  return (
    <Panel title="Send it" description={order.contactEmail ? `Emails ${order.contactName} (${order.contactEmail}) a private link to view${order.kind === "quote" ? " and accept" : ""} it. Save any changes first.` : `${order.contactName} has no email address. Add one to their contact first.`}>
      {send.error ? <Callout tone="bad">{send.error}</Callout> : null}
      <div className="form-actions">
        <Button variant="primary" icon="mail" loading={send.busy} onClick={doSend} disabled={!order.contactEmail}>
          Send {order.kind}
        </Button>
        <Button variant="ghost" className="danger" onClick={del}>
          Delete draft
        </Button>
      </div>
    </Panel>
  );
}

function OrderRecord({ order: o, onChanged, onEdit }: { order: OrderDetail; onChanged: (o?: OrderDetail) => void; onEdit: () => void }) {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const tz = me?.studio.timezone ?? "UTC";
  const cur = useLoad<{ currency: string }>("/money/settings").data?.currency ?? "USD";
  const money = (c: number) => formatMoney(c, cur);
  const [paying, setPaying] = useState<"pay" | "refund" | null>(null);
  const act = async (path: string, done: string, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    try {
      onChanged(await api<OrderDetail>(`/orders/${o.id}/${path}`, { method: "POST" }));
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  const [creditBusy, setCreditBusy] = useState(false);
  const applyCredit = {
    busy: creditBusy,
    run: async () => {
      setCreditBusy(true);
      try {
        onChanged(await api<OrderDetail>(`/orders/${o.id}/apply-credit`, { body: {} }));
        toast("Credit applied");
      } catch (e) {
        toast(e instanceof Error ? e.message : "That didn't work.");
      } finally {
        setCreditBusy(false);
      }
    },
  };
  const open = o.kind === "invoice" && o.state !== "void";

  return (
    <>
      <header className="order-head">
        <div>
          <h1 className="page-title">{o.title}</h1>
          <p className="muted order-sub">
            {o.label} for <Link to={`/studio/clients/${o.contactId}`}>{o.contactName}</Link>
            {o.shootId ? (
              <>
                {" · "}
                <Link to={`/studio/shoots/${o.shootId}`}>shoot</Link>
              </>
            ) : null}
          </p>
        </div>
        <StatusChip tone={stateTone(o.state)}>{stateLabel[o.state]}</StatusChip>
      </header>

      {o.kind === "quote" && o.state === "sent" ? <Callout tone="info" title="Waiting for the client">{o.viewedAt ? `Opened ${formatDate(ms(o.viewedAt), tz)}.` : "Not opened yet."} Valid until {o.validUntil}.</Callout> : null}
      {o.state === "expired" ? <Callout tone="warn" title="This quote expired">Take it back to a draft, move the date, and send it again.</Callout> : null}
      {o.state === "declined" ? <Callout tone="bad" title="The client declined this quote" /> : null}
      {o.acceptedAt ? <Callout tone="ok" title={`Accepted by ${o.acceptedName}`}>{formatDate(ms(o.acceptedAt), tz)}. It became this invoice.</Callout> : null}

      <div className="split">
        <div className="stack">
          <Panel title="What's included" flush>
            <table className="doc-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.description}
                      {l.detail ? <small>{l.detail}</small> : null}
                    </td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{money(l.unitCents)}</td>
                    <td className="num">{money(l.quantity * l.unitCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="totals pad">
              <div><dt>Subtotal</dt><dd>{money(o.subtotalCents)}</dd></div>
              {o.discountCents ? <div><dt>Discount</dt><dd>−{money(o.discountCents)}</dd></div> : null}
              {o.couponCents ? <div><dt>Coupon {o.couponCode}</dt><dd>−{money(o.couponCents)}</dd></div> : null}
              {o.taxCents ? <div><dt>{o.taxLabel || "Tax"}</dt><dd>{money(o.taxCents)}</dd></div> : null}
              <div className="grand"><dt>Total</dt><dd>{money(o.totalCents)}</dd></div>
              {open ? <div><dt>Paid</dt><dd>{money(o.paidCents)}</dd></div> : null}
              {open ? <div className="grand"><dt>Balance</dt><dd>{money(o.balanceCents)}</dd></div> : null}
            </dl>
          </Panel>

          {open ? (
            <Panel
              title="Payments"
              actions={
                <>
                  {o.balanceCents > 0 && o.state !== "void" ? <Button variant="primary" size="sm" icon="plus" onClick={() => setPaying("pay")}>Record a payment</Button> : null}
                </>
              }
              flush
            >
              <ul className="sched-rows">
                {o.schedule.map((s) => (
                  <li key={s.id}>
                    <span>
                      <b>{s.label}</b>
                      <small>{s.dueDate ? `Due ${s.dueDate}` : "Due on acceptance"}</small>
                    </span>
                    <StatusChip tone={s.status === "paid" ? "ok" : s.status === "overdue" ? "bad" : "neutral"}>{s.status === "paid" ? "Paid" : s.status === "overdue" ? "Overdue" : s.paidCents ? "Part paid" : "Due"}</StatusChip>
                    <b>{money(s.amountCents)}</b>
                  </li>
                ))}
              </ul>
              {o.payments.length ? (
                <ul className="sched-rows received">
                  {o.payments.map((p) => (
                    <li key={p.id}>
                      <span>
                        <b>{p.amountCents < 0 ? "Refund" : "Received"} · {METHODS.find(([k]) => k === p.method)?.[1] ?? p.method}</b>
                        <small>
                          {formatDate(ms(p.paidAt), tz)}
                          {p.note ? ` · ${p.note}` : ""}
                        </small>
                      </span>
                      <span />
                      <b>{money(p.amountCents)}</b>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}
        </div>

        <aside className="stack">
          <Panel title="Client link" description="Anyone with this link can view it. Send it yourself if email isn't set up.">
            <CopyValue value={o.link.startsWith("/") ? window.location.origin + o.link : o.link} label="Client link" />
          </Panel>
          <Panel title="Actions">
            <div className="stack-tight">
              {o.kind === "quote" && (o.state === "sent" || o.state === "expired" || o.state === "declined") ? (
                <Button block onClick={() => act("reopen", "Back to a draft.")}>Take back to draft</Button>
              ) : null}
              {o.kind === "invoice" && (o.creditAvailableCents ?? 0) > 0 ? (
                <Button block onClick={applyCredit.run} loading={applyCredit.busy}>Use {money(o.creditAvailableCents!)} of their credit</Button>
              ) : null}
              {o.state === "partial" || o.state === "paid" ? owner ? <Button block onClick={() => setPaying("refund")}>Record a refund</Button> : null : null}
              {o.state !== "void" && o.paidCents === 0 ? (
                <Button block variant="ghost" className="danger" onClick={() => act("void", "Voided.", `Void ${o.label}? The client's link will say it is no longer valid.`)}>
                  Void {o.kind}
                </Button>
              ) : null}
            </div>
          </Panel>
          {o.terms ? (
            <Panel title="Terms">
              <p className="terms">{o.terms}</p>
            </Panel>
          ) : null}
        </aside>
      </div>

      <PaymentDialog
        mode={paying}
        order={o}
        cur={cur}
        onClose={() => setPaying(null)}
        onDone={(x) => {
          setPaying(null);
          onChanged(x);
          toast(paying === "refund" ? "Refund recorded" : "Payment recorded");
        }}
      />
      {void onEdit}
    </>
  );
}

function PaymentDialog({ mode, order, cur, onClose, onDone }: { mode: "pay" | "refund" | null; order: OrderDetail; cur: string; onClose: () => void; onDone: (o: OrderDetail) => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("check");
  const [note, setNote] = useState("");
  const refund = mode === "refund";
  const suggested = refund ? order.paidCents : order.schedule.find((s) => s.status !== "paid") ? Math.min(order.balanceCents, order.schedule.find((s) => s.status !== "paid")!.amountCents - order.schedule.find((s) => s.status !== "paid")!.paidCents) : order.balanceCents;
  const { busy, error, submit } = useSubmit(() => {
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) throw new Error("Enter the amount.");
    return api<OrderDetail>(`/orders/${order.id}/${refund ? "refunds" : "payments"}`, { body: { amountCents: cents, method, note: note || null } });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit();
    if (r) {
      setAmount("");
      setNote("");
      onDone(r);
    }
  };
  return (
    <Dialog
      open={!!mode}
      onClose={onClose}
      title={refund ? "Record a refund" : "Record a payment"}
      description={refund ? `Up to ${formatMoney(order.paidCents, cur)} has been paid.` : `${formatMoney(order.balanceCents, cur)} is still owed. The client gets a receipt by email.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="pay-form" type="submit" loading={busy}>{refund ? "Record refund" : "Record payment"}</Button>
        </>
      }
    >
      <form id="pay-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field label="Amount" hint={suggested > 0 ? `Next due: ${formatMoney(suggested, cur)}` : undefined}>
          {(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={() => !amount && suggested > 0 && setAmount(moneyInput(suggested))} />}
        </Field>
        <Field label="How">
          {(p) => (
            <select {...p} className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.filter(([k]) => refund || k !== "credit").map(([k, label]) => <option key={k} value={k}>{k === "credit" ? "Keep as client credit" : label}</option>)}
            </select>
          )}
        </Field>
        <Field className="span-2" label="Note" hint="Optional. A check number, or who paid.">
          {(p) => <TextInput {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
