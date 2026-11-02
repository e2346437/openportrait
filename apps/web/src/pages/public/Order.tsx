import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router";
import { Button, Callout, Field, Spinner, StatusChip, TextInput } from "@openportrait/ui";
import { publicApi } from "../../lib/api.js";
import { formatMoney, stateLabel, stateTone, type OrderState } from "../../lib/money.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { PublicMessage, PublicShell } from "./PublicShell.js";

interface View {
  studioName: string;
  currency: string;
  kind: "quote" | "invoice";
  label: string;
  title: string;
  state: OrderState;
  intro: string | null;
  terms: string | null;
  lines: Array<{ description: string; detail: string | null; quantity: number; unitCents: number }>;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  validUntil: string | null;
  acceptedName: string | null;
  schedule: Array<{ label: string; amountCents: number; dueDate: string | null; paidCents: number; status: "paid" | "due" | "overdue" }>;
  paymentInstructions: string;
  contactName: string;
  couponCode: string | null;
  couponCents: number;
  credit: { availableCents: number } | null;
  pay: { provider: string; name: string; dueCents: number; balanceCents: number } | null;
}

/** What a client sees at their private link: the quote to read and accept, or the invoice to pay. */
export function OrderViewPage() {
  const { token = "" } = useParams();
  const { data, setData, error, loading } = useLoad<View>(`/order/${encodeURIComponent(token)}`, { api: publicApi });
  const [name, setName] = useState("");
  const [declining, setDeclining] = useState(false);
  const accept = useSubmit(() => publicApi<View>(`/order/${encodeURIComponent(token)}/accept`, { body: { name } }));
  const [qs, setQs] = useSearchParams();
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const captured = useRef(false);
  const goPay = async (amount: "due" | "balance") => {
    const r = await publicApi<{ approveUrl: string }>(`/order/${encodeURIComponent(token)}/pay`, { body: { amount } });
    window.location.assign(r.approveUrl);
    return r;
  };
  const useCredit = useSubmit(() => publicApi<View>(`/order/${encodeURIComponent(token)}/credit`, { body: {} }));
  const payDue = useSubmit(() => goPay("due"));
  const payAll = useSubmit(() => goPay("balance"));
  // Coming back from PayPal: finish the payment, then show the result and tidy the address bar.
  useEffect(() => {
    const paypalId = qs.get("token");
    if (qs.get("pay") === "cancel") {
      setNote({ tone: "warn", text: "Payment cancelled. You haven't been charged." });
      setQs({}, { replace: true });
    } else if (qs.get("pay") === "return" && paypalId && !captured.current) {
      captured.current = true;
      setNote({ tone: "warn", text: "Confirming your payment…" });
      publicApi<View & { outcome: "paid" | "pending" }>(`/order/${encodeURIComponent(token)}/pay/capture`, { body: { providerOrderId: paypalId } })
        .then((r) => {
          setData(r);
          setNote(r.outcome === "paid" ? { tone: "ok", text: "Payment received. Thank you!" } : { tone: "warn", text: "Your payment is being processed. This page will show it once PayPal confirms." });
        })
        .catch((e: Error) => setNote({ tone: "bad", text: e.message }))
        .finally(() => setQs({}, { replace: true }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const decline = useSubmit(() => publicApi<View>(`/order/${encodeURIComponent(token)}/decline`, { body: {} }));

  if (loading) return <PublicShell narrow><Spinner label="Loading" /></PublicShell>;
  if (error || !data) return <PublicMessage title="We couldn't find that page">The link may be incomplete. Please contact the studio directly.</PublicMessage>;
  const v = data;
  const m = (c: number) => formatMoney(c, v.currency);
  const quote = v.kind === "quote";
  const dead = v.state === "void" || v.state === "declined" || v.state === "expired";
  const onAccept = async (e: FormEvent) => {
    e.preventDefault();
    const r = await accept.submit();
    if (r) setData(r);
  };

  return (
    <PublicShell studio={v.studioName}>
      <header className="doc-head">
        <div>
          <h1 className="pub-title">{v.title}</h1>
          <p className="muted">
            {v.label} for {v.contactName}
          </p>
        </div>
        <StatusChip tone={stateTone(v.state)}>{quote && v.state === "sent" ? "Awaiting your answer" : stateLabel[v.state]}</StatusChip>
      </header>
      {v.intro ? <p className="pub-lead">{v.intro}</p> : null}
      {v.state === "void" ? <Callout tone="bad" title="This is no longer valid">Please contact the studio.</Callout> : null}
      {v.state === "expired" ? <Callout tone="warn" title="This quote has expired">It was good until {v.validUntil}. Please contact the studio for a new one.</Callout> : null}
      {v.state === "declined" ? <Callout tone="neutral" title="You declined this quote">Changed your mind? Contact the studio.</Callout> : null}

      <div className="doc-scroll">
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
            {v.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.description}
                  {l.detail ? <small>{l.detail}</small> : null}
                </td>
                <td className="num">{l.quantity}</td>
                <td className="num">{m(l.unitCents)}</td>
                <td className="num">{m(l.quantity * l.unitCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="totals">
        <div><dt>Subtotal</dt><dd>{m(v.subtotalCents)}</dd></div>
        {v.discountCents ? <div><dt>Discount</dt><dd>−{m(v.discountCents)}</dd></div> : null}
        {v.couponCents ? <div><dt>Coupon {v.couponCode}</dt><dd>−{m(v.couponCents)}</dd></div> : null}
        {v.taxCents ? <div><dt>Tax</dt><dd>{m(v.taxCents)}</dd></div> : null}
        <div className="grand"><dt>Total</dt><dd>{m(v.totalCents)}</dd></div>
        {!quote ? <div><dt>Paid</dt><dd>{m(v.paidCents)}</dd></div> : null}
        {!quote ? <div className="grand"><dt>Balance due</dt><dd>{m(v.balanceCents)}</dd></div> : null}
      </dl>

      {v.schedule.length > 1 || !quote ? (
        <section className="doc-section">
          <h2>Payments</h2>
          <ul className="sched-rows">
            {v.schedule.map((s, i) => (
              <li key={i}>
                <span>
                  <b>{s.label}</b>
                  <small>{s.dueDate ? `Due ${s.dueDate}` : quote ? "Due once you accept" : "Due now"}</small>
                </span>
                {!quote ? <StatusChip tone={s.status === "paid" ? "ok" : s.status === "overdue" ? "bad" : "neutral"}>{s.status === "paid" ? "Paid" : s.status === "overdue" ? "Overdue" : "Due"}</StatusChip> : <span />}
                <b>{m(s.amountCents)}</b>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {note ? <Callout tone={note.tone}>{note.text}</Callout> : null}
      {!quote && v.credit && v.state !== "void" ? (
        <section className="doc-section pay-box">
          <h2>Your credit</h2>
          {useCredit.error ? <Callout tone="bad">{useCredit.error}</Callout> : null}
          <p className="muted">You have {m(v.credit.availableCents)} of credit with {v.studioName || "the studio"}. Use it toward this invoice.</p>
          <div className="form-actions">
            <Button size="lg" loading={useCredit.busy} onClick={async () => { const r = await useCredit.submit(); if (r) { setData(r); setNote({ tone: "ok", text: "Your credit has been applied. Thank you!" }); } }}>
              Use {m(v.credit.availableCents)} of my credit
            </Button>
          </div>
        </section>
      ) : null}
      {!quote && v.pay ? (
        <section className="doc-section pay-box">
          <h2>Pay online</h2>
          {payDue.error || payAll.error ? <Callout tone="bad">{payDue.error || payAll.error}</Callout> : null}
          <div className="form-actions">
            <Button variant="primary" size="lg" loading={payDue.busy} disabled={payAll.busy} onClick={() => payDue.submit()}>
              Pay {m(v.pay.dueCents)} with {v.pay.name}
            </Button>
            {v.pay.balanceCents > v.pay.dueCents ? (
              <Button size="lg" loading={payAll.busy} disabled={payDue.busy} onClick={() => payAll.submit()}>
                Pay the full balance, {m(v.pay.balanceCents)}
              </Button>
            ) : null}
          </div>
          <p className="muted">You'll finish on {v.pay.name}'s secure page, then come straight back here.</p>
        </section>
      ) : null}
      {!quote && v.balanceCents > 0 && v.state !== "void" && v.paymentInstructions ? (
        <section className="doc-section">
          <h2>How to pay</h2>
          <p className="terms">{v.paymentInstructions}</p>
        </section>
      ) : null}
      {!quote && v.state === "paid" ? <Callout tone="ok" title="Paid in full. Thank you.">{v.acceptedName ? `Accepted by ${v.acceptedName}.` : ""}</Callout> : null}

      {quote && v.state === "sent" ? (
        <section className="doc-section accept">
          <h2>Accept this quote</h2>
          <p className="muted">Type your full name to accept. {v.validUntil ? `This quote is good until ${v.validUntil}.` : ""}</p>
          <form onSubmit={onAccept} noValidate className="form-grid">
            {accept.error ? <div className="span-2"><Callout tone="bad">{accept.error}</Callout></div> : null}
            <Field className="span-2" label="Your full name">{(p) => <TextInput {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <div className="span-2 form-actions">
              <Button variant="primary" size="lg" type="submit" loading={accept.busy}>Accept and continue</Button>
              {declining ? (
                <Button variant="ghost" loading={decline.busy} onClick={async () => { const r = await decline.submit(); if (r) setData(r); }}>Yes, decline this quote</Button>
              ) : (
                <Button variant="ghost" type="button" onClick={() => setDeclining(true)}>Decline</Button>
              )}
            </div>
          </form>
        </section>
      ) : null}

      {v.terms && !dead ? (
        <section className="doc-section">
          <h2>Terms</h2>
          <p className="terms">{v.terms}</p>
        </section>
      ) : null}
    </PublicShell>
  );
}
