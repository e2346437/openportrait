import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Callout, Dialog, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { formatMoney, moneyInput, parseMoney, type OrderSummary } from "../lib/money.js";
import { useSubmit } from "../lib/useForm.js";
import { useLoad } from "../lib/useLoad.js";
import type { ShootDetail } from "../lib/types.js";

type Split = "per_party" | "per_person";
interface Billing {
  costs: Array<{ id: string; label: string; amountCents: number }>;
  totalCostCents: number;
  split: Split;
  coveredCount: number;
  billableCount: number;
  people: Array<{ id: string; subject: string; billTo: "self" | "parent"; headcount: number; frames: number; hasInvoice: boolean; shareCents: number }>;
}
interface DraftLine {
  id: string;
  description: string;
  quantity: number;
}

const BILLING = {
  self: "Each person is billed on their own",
  parent: "One invoice to the organisation covers everyone",
} as const;

/** Billing for a group day: who pays, the shared costs and how they are split, invoices per person, and the day's own invoice. */
export function GroupDayBilling({ shoot, onChange }: { shoot: ShootDetail; onChange: (next: ShootDetail) => void | Promise<void> }) {
  const toast = useToast();
  const [split, setSplit] = useState<Split>("per_party");
  const { data, error, reload } = useLoad<Billing>(`/shoots/${shoot.id}/billing?split=${split}`);
  const drafts = useLoad<{ items: OrderSummary[] }>(`/orders?shootId=${shoot.id}`);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [making, setMaking] = useState(false);

  useEffect(() => void reload(), [shoot.children.length, reload]);

  const setBilling = async (billTo: "self" | "parent") => {
    try {
      await onChange(await api<ShootDetail>(`/shoots/${shoot.id}`, { method: "PATCH", body: { billTo } }));
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't save.", "bad");
    }
  };
  const addCost = useSubmit(async () => {
    const cents = parseMoney(amount);
    if (cents === null || cents <= 0) throw new Error("Enter the cost as an amount, such as 200.00.");
    await api(`/shoots/${shoot.id}/costs`, { method: "POST", body: { label, amountCents: cents } });
    setLabel("");
    setAmount("");
    await reload();
  });
  const removeCost = async (id: string) => {
    try {
      await api(`/shoots/${shoot.id}/costs/${id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't work.", "bad");
    }
  };
  const unlock = useSubmit(async () => {
    const r = await api<{ unlocked: number }>(`/shoots/${shoot.id}/unlock-galleries`, { method: "POST" });
    toast(r.unlocked ? `Downloads opened on ${r.unlocked} ${r.unlocked === 1 ? "gallery" : "galleries"}` : "Nothing was locked");
  });
  const go = (e: FormEvent) => {
    e.preventDefault();
    void addCost.submit();
  };

  const own = data?.people.filter((p) => p.billTo === "self") ?? [];
  const shares = own.filter((p) => p.frames > 0);
  const share0 = shares[0]?.shareCents ?? 0;
  const varies = shares.some((p) => p.shareCents !== share0);
  const draftInvoices = (drafts.data?.items ?? []).filter((o) => o.kind === "invoice" && o.state === "draft" && o.contactId === shoot.primary.id);

  return (
    <>
      <Panel title="Billing" description="Who pays for this day, and how shared costs are split.">
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
        <p className="hint">Applies to people you add from now on. You can change any one person on their own page.</p>

        {error && !data ? <Callout tone="bad">{error}</Callout> : null}

        {shoot.billTo === "parent" || (data?.coveredCount ?? 0) > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b>The day's invoice</b>
            <p className="hint" style={{ margin: "2px 0 8px" }}>
              {data?.coveredCount ?? 0} {(data?.coveredCount ?? 0) === 1 ? "person" : "people"} photographed so far. Create the invoice from the Orders panel, with a line priced per person.
            </p>
            {draftInvoices.map((o) => (
              <RecountRow key={o.id} order={o} onDone={async () => { await drafts.reload(); await reload(); }} />
            ))}
          </div>
        ) : null}

        {own.length ? (
          <div style={{ marginTop: 16 }}>
            <b>Shared costs</b>
            <p className="hint" style={{ margin: "2px 0 8px" }}>Location fee, travel, anything the whole day shares. Each person's invoice gets their share as one line; nobody sees the others.</p>
            {data?.costs.length ? (
              <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }} aria-label="Shared costs">
                {data.costs.map((c) => (
                  <li key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line, rgba(0,0,0,.08))" }}>
                    <span style={{ flex: 1, overflowWrap: "anywhere" }}>{c.label}</span>
                    <span>{formatMoney(c.amountCents)}</span>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${c.label}`} onClick={() => void removeCost(c.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form onSubmit={go} className="form-grid" noValidate>
              {addCost.error ? (
                <div className="span-2">
                  <Callout tone="bad">{addCost.error}</Callout>
                </div>
              ) : null}
              <Field label="Cost">{(p) => <TextInput {...p} autoComplete="off" value={label} maxLength={120} placeholder="Location fee" onChange={(e) => setLabel(e.target.value)} />}</Field>
              <Field label="Amount">{(p) => <TextInput {...p} inputMode="decimal" autoComplete="off" value={amount} placeholder="200.00" onChange={(e) => setAmount(e.target.value)} />}</Field>
              <div className="form-actions span-2">
                <Button type="submit" icon="plus" loading={addCost.busy} disabled={!label.trim() || !amount.trim()}>
                  Add cost
                </Button>
              </div>
            </form>

            {data && data.totalCostCents > 0 ? (
              <>
                <Field label="Split between">
                  {(p) => (
                    <select {...p} className="input" value={split} onChange={(e) => setSplit(e.target.value as Split)}>
                      <option value="per_party">Equal share per family or person</option>
                      <option value="per_person">By number of people in each</option>
                    </select>
                  )}
                </Field>
                <p className="hint" style={{ marginTop: 6 }}>
                  {shares.length === 0
                    ? "Nobody has been photographed yet, so there is nothing to split."
                    : `${formatMoney(data.totalCostCents)} across ${shares.length} ${shares.length === 1 ? "family or person" : "families or people"}: ${varies ? "about " : ""}${formatMoney(share0)} each${varies ? " (a few cents differ so the total is exact)" : ""}.`}
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 16 }}>
          {own.length ? (
            <Button variant="primary" icon="plus" disabled={shares.length === 0} onClick={() => setMaking(true)}>
              Create {shares.length || ""} draft invoice{shares.length === 1 ? "" : "s"}
            </Button>
          ) : null}
          <Button loading={unlock.busy} onClick={() => void unlock.submit()}>
            Open downloads for everyone
          </Button>
        </div>
        <p className="hint">Drafts are never emailed on their own. Open downloads once the day's invoice is paid.</p>
      </Panel>

      <MakeInvoices open={making} dayId={shoot.id} split={split} billing={data ?? null} onClose={() => setMaking(false)} onDone={async () => { setMaking(false); await reload(); await drafts.reload(); }} />
    </>
  );
}

function RecountRow({ order, onDone }: { order: OrderSummary; onDone: () => void | Promise<void> }) {
  const toast = useToast();
  const detail = useLoad<{ lines: DraftLine[] }>(`/orders/${order.id}`);
  const [lineId, setLineId] = useState("");
  const lines = detail.data?.lines ?? [];
  useEffect(() => {
    if (!lineId && lines.length) setLineId((lines.find((l) => /person|people|head/i.test(l.description)) ?? lines[lines.length - 1]!).id);
  }, [lines, lineId]);
  const run = useSubmit(async () => {
    const r = await api<{ count: number }>(`/orders/${order.id}/recount`, { method: "POST", body: { lineId } });
    toast(`Set to ${r.count} ${r.count === 1 ? "person" : "people"}`);
    await onDone();
    await detail.reload();
  });
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 0" }}>
      <Link to={`/studio/orders/${order.id}`}>
        {order.label} (draft)
      </Link>
      <label className="sr-only" htmlFor={`rc-${order.id}`}>
        Per-person line
      </label>
      <select id={`rc-${order.id}`} className="input" style={{ width: "auto", maxWidth: "100%" }} value={lineId} onChange={(e) => setLineId(e.target.value)}>
        {lines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.description} (now {l.quantity})
          </option>
        ))}
      </select>
      <Button size="sm" loading={run.busy} disabled={!lineId} onClick={() => void run.submit()}>
        Recount people
      </Button>
      {run.error ? <Callout tone="bad">{run.error}</Callout> : null}
    </div>
  );
}

function MakeInvoices({ open, dayId, split, billing, onClose, onDone }: { open: boolean; dayId: string; split: Split; billing: Billing | null; onClose: () => void; onDone: () => void | Promise<void> }) {
  const toast = useToast();
  const [desc, setDesc] = useState("Mini session");
  const [price, setPrice] = useState("");
  const [result, setResult] = useState<{ created: number; skipped: Array<{ subject: string; reason: string }> } | null>(null);
  const targets = billing?.people.filter((p) => p.billTo === "self" && p.frames > 0 && !p.hasInvoice) ?? [];
  const cents = parseMoney(price);
  const run = useSubmit(async () => {
    if (cents === null || cents < 0) throw new Error("Enter the price as an amount, such as 175.00.");
    const r = await api<{ created: unknown[]; skipped: Array<{ subject: string; reason: string }> }>(`/shoots/${dayId}/invoices`, { method: "POST", body: { lines: [{ description: desc, unitCents: cents }], split } });
    toast(`${r.created.length} draft ${r.created.length === 1 ? "invoice" : "invoices"} created`);
    if (r.skipped.length) setResult({ created: r.created.length, skipped: r.skipped });
    else await onDone();
  });
  const close = () => {
    const had = result;
    setResult(null);
    if (had) void onDone();
    else onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Create draft invoices"
      description="One invoice for each person photographed who is billed on their own. They stay drafts until you send them."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {result ? "Done" : "Cancel"}
          </Button>
          {result ? null : (
            <Button variant="primary" loading={run.busy} disabled={!desc.trim() || !targets.length} onClick={() => void run.submit()}>
              Create {targets.length} {targets.length === 1 ? "draft" : "drafts"}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {run.error ? <Callout tone="bad">{run.error}</Callout> : null}
        {result ? (
          <Callout tone="warn" title={`${result.created} created`}>
            {result.skipped.map((s) => `${s.subject}: ${s.reason}`).join("\n")}
          </Callout>
        ) : (
          <>
            <Field label="Line on each invoice">{(p) => <TextInput {...p} autoComplete="off" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} />}</Field>
            <Field label="Price" hint={billing?.totalCostCents ? "Each invoice also gets that person's share of the shared costs." : undefined}>
              {(p) => <TextInput {...p} inputMode="decimal" autoComplete="off" value={price} placeholder={moneyInput(17500)} onChange={(e) => setPrice(e.target.value)} />}
            </Field>
            <p className="hint" style={{ margin: 0 }}>
              {targets.length ? `For: ${targets.map((t) => t.subject).join(", ")}` : "Everyone photographed already has an invoice."}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
