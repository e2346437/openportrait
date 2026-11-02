import { useState, type FormEvent } from "react";
import { Button, Callout, Dialog, Field, Panel, Spinner, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { formatMoney, parseMoney } from "../lib/money.js";
import { relative } from "../lib/time.js";
import { useSession } from "../lib/session.js";
import { useSubmit } from "../lib/useForm.js";
import { useLoad } from "../lib/useLoad.js";

interface Credit {
  balanceCents: number;
  entries: Array<{ id: string; amountCents: number; kind: "grant" | "applied" | "refund" | "removed"; note: string | null; createdAt: string | number }>;
}
const KIND: Record<Credit["entries"][number]["kind"], string> = { grant: "Added", applied: "Used on an invoice", refund: "Refund kept as credit", removed: "Removed" };

/** What the studio owes this client: gift cards, prepayments and refunds kept as credit. They can spend it on invoices. */
export function CreditPanel({ contactId }: { contactId: string }) {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const cur = useLoad<{ currency: string }>("/money/settings").data?.currency ?? "USD";
  const { data, error, reload } = useLoad<Credit>(`/contacts/${contactId}/credit`);
  const [mode, setMode] = useState<"add" | "remove" | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const save = useSubmit(() => {
    const cents = parseMoney(amount);
    if (cents === null || cents <= 0) throw new Error("Enter an amount like 50.00.");
    return api(`/contacts/${contactId}/credit${mode === "remove" ? "/remove" : ""}`, { body: { amountCents: cents, note: note || null } });
  });
  const close = () => {
    setMode(null);
    setAmount("");
    setNote("");
  };
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.submit()) === undefined) return;
    toast(mode === "remove" ? "Credit removed" : "Credit added");
    close();
    reload();
  };

  return (
    <Panel
      title="Credit"
      description="Money you owe this client. They can use it on any invoice."
      actions={owner ? <Button size="sm" icon="plus" onClick={() => setMode("add")}>Add</Button> : null}
    >
      {error && !data ? <Callout tone="bad">{error}</Callout> : null}
      {!data && !error ? <Spinner label="Loading" /> : null}
      {data ? (
        <>
          <p className="credit-balance">
            <b>{formatMoney(data.balanceCents, cur)}</b>
            <span>available</span>
          </p>
          {data.entries.length ? (
            <ul className="credit-log">
              {data.entries.slice(0, 5).map((e) => (
                <li key={e.id}>
                  <span>
                    {KIND[e.kind]}
                    {e.note ? <small>{e.note}</small> : null}
                  </span>
                  <b className={e.amountCents < 0 ? "neg" : ""}>{e.amountCents < 0 ? "−" : "+"}{formatMoney(Math.abs(e.amountCents), cur)}</b>
                  <time>{relative(new Date(e.createdAt).getTime())}</time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No credit yet. Add some for a gift card or a prepayment, or refund an invoice as credit.</p>
          )}
          {owner && data.balanceCents > 0 ? <div><Button size="sm" variant="ghost" onClick={() => setMode("remove")}>Remove credit</Button></div> : null}
        </>
      ) : null}
      <Dialog
        open={!!mode}
        onClose={close}
        title={mode === "remove" ? "Remove credit" : "Add credit"}
        description={mode === "remove" ? "Use this to correct a mistake. It can't go below zero." : "The client can use this toward any invoice. It isn't a payment, so it won't show as income until it's used."}
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" form="credit-form" type="submit" loading={save.busy}>{mode === "remove" ? "Remove" : "Add credit"}</Button>
          </>
        }
      >
        <form id="credit-form" onSubmit={go} noValidate className="form-grid">
          {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
          <Field label="Amount">{(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Note" hint="Optional. For example: gift card from Mom.">{(p) => <TextInput {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </form>
      </Dialog>
    </Panel>
  );
}
