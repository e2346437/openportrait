import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Callout, Dialog, EmptyState, Field, PageHeader, Spinner, StatusChip, TextInput } from "@openportrait/ui";
import { ContactPicker, type PickedContact } from "../../components/ContactPicker.js";
import { api } from "../../lib/api.js";
import { contractLabel, contractTone, type ContractDetail, type ContractSummary } from "../../lib/contracts.js";
import { useSession } from "../../lib/session.js";
import { formatDate, ms } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useDebounced, useLoad } from "../../lib/useLoad.js";

const filters = [
  ["all", "All"],
  ["sent", "Awaiting signature"],
  ["signed", "Signed"],
  ["draft", "Drafts"],
] as const;

/** Every contract, and a way to make a new one from a template. */
export function ContractsPage() {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<(typeof filters)[number][0]>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(!!params.get("contact"));
  const term = useDebounced(q.trim());
  const status = filter === "all" ? "" : `&status=${filter}`;
  const { data, error, loading } = useLoad<{ items: ContractSummary[] }>(`/contracts?q=${encodeURIComponent(term)}${status}`);
  const items = data?.items ?? [];
  return (
    <>
      <PageHeader title="Contracts" description="Send an agreement, have it signed online, and keep a signed copy with a record of who signed and when." actions={<Button icon="plus" variant="primary" onClick={() => setCreating(true)}>New contract</Button>} />
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Show">
          {filters.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <div className="grow-search">
          <TextInput type="search" placeholder="Search by title or client" aria-label="Search contracts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {loading && !data ? <Spinner label="Loading" /> : null}
      {data && items.length === 0 ? (
        <EmptyState icon="note" title={term || filter !== "all" ? "Nothing matches" : "No contracts yet"} action={!term && filter === "all" ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Make your first contract</Button> : undefined}>
          {term || filter !== "all" ? "Try a different search or filter." : "Write a template once under Settings, then send it to a client to sign online."}
        </EmptyState>
      ) : null}
      {items.length ? (
        <ul className="order-list">
          {items.map((c) => (
            <li key={c.id}>
              <Link to={`/studio/contracts/${c.id}`} className="order-row">
                <span className="order-main">
                  <b>{c.title}</b>
                  <small>{c.contactName} · {c.signedAt ? `signed ${formatDate(ms(c.signedAt), tz, { month: "short", day: "numeric", year: "numeric" })}` : c.sentAt ? `sent ${formatDate(ms(c.sentAt), tz, { month: "short", day: "numeric", year: "numeric" })}` : `started ${formatDate(ms(c.createdAt), tz, { month: "short", day: "numeric", year: "numeric" })}`}</small>
                </span>
                <StatusChip tone={contractTone(c.state)}>{contractLabel[c.state]}</StatusChip>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <NewContractDialog open={creating} contactId={params.get("contact")} onClose={() => setCreating(false)} />
    </>
  );
}

function NewContractDialog({ open, contactId, onClose }: { open: boolean; contactId: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [shootId, setShootId] = useState("");
  const [orderId, setOrderId] = useState("");
  const templates = useLoad<{ items: Array<{ id: string; name: string }> }>(open ? "/contract-templates" : null).data?.items ?? [];
  const preset = useLoad<{ name: string }>(open && contactId && !contact ? `/contacts/${contactId}` : null).data;
  const who = contact ?? (contactId && preset ? { id: contactId, name: preset.name } : null);
  const links = useLoad<{ shoots: Array<{ id: string; subject: string }> }>(who ? `/contacts/${who.id}` : null).data;
  const orders = useLoad<{ items: Array<{ id: string; title: string; label: string }> }>(who ? `/orders?contactId=${who.id}` : null).data?.items ?? [];
  const { busy, error, submit } = useSubmit(() => {
    if (!who) throw new Error("Choose who this is for.");
    if (!templateId) throw new Error("Choose a template.");
    return api<ContractDetail>("/contracts", { body: { contactId: who.id, templateId, shootId: shootId || null, orderId: orderId || null } });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    const c = await submit();
    if (c) navigate(`/studio/contracts/${c.id}`);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New contract"
      description="Pick a client and a template. You can read and adjust it before anything is sent."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="new-contract" type="submit" loading={busy}>Create draft</Button>
        </>
      }
    >
      <form id="new-contract" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <div className="span-2"><ContactPicker value={who} onChange={setContact} /></div>
        <Field className="span-2" label="Template" hint={templates.length ? undefined : "Add a template under Settings > Contracts first."}>
          {(p) => (
            <select {...p} className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </Field>
        {who && links?.shoots.length ? (
          <Field label="Shoot" hint="Fills in the shoot's name, type and date.">
            {(p) => (
              <select {...p} className="input" value={shootId} onChange={(e) => setShootId(e.target.value)}>
                <option value="">None</option>
                {links.shoots.map((s) => <option key={s.id} value={s.id}>{s.subject}</option>)}
              </select>
            )}
          </Field>
        ) : null}
        {who && orders.length ? (
          <Field label="Quote or invoice" hint="Fills in its title and total.">
            {(p) => (
              <select {...p} className="input" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                <option value="">None</option>
                {orders.map((o) => <option key={o.id} value={o.id}>{o.label}: {o.title}</option>)}
              </select>
            )}
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
