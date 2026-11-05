import { useState, type DragEvent, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Callout, Dialog, EmptyState, Field, Icon, PageHeader, StatusChip, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDate, relative } from "../../lib/time.js";
import type { BoardStage, LeadCard, ShootType } from "../../lib/types.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { ContactPicker, type PickedContact } from "../../components/ContactPicker.js";

export function LeadsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const { data, error, reload, setData } = useLoad<{ stages: BoardStage[] }>("/leads");
  const [search, setSearch] = useSearchParams();
  // `?new` opens the dialog straight away (the home page's quick action).
  const [adding, setAdding] = useState(search.has("new"));
  const closeNew = () => {
    setAdding(false);
    if (search.has("new")) {
      const next = new URLSearchParams(search);
      next.delete("new");
      setSearch(next, { replace: true });
    }
  };
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [losing, setLosing] = useState<LeadCard | null>(null);

  const stages = data?.stages ?? [];
  const totalOpen = stages.filter((s) => s.kind === "open").reduce((n, s) => n + s.total, 0);

  const move = async (lead: LeadCard, to: BoardStage) => {
    if (lead.stageId === to.id) return;
    if (to.kind === "won") {
      // Winning means booking the shoot, which needs a date and type, so continue on the lead page.
      navigate(`/studio/leads/${lead.id}?book=1`);
      return;
    }
    if (to.kind === "lost") {
      setLosing(lead);
      return;
    }
    // Optimistic move: the card jumps now and snaps back if the server says no.
    const before = data;
    setData((d) =>
      d
        ? {
            stages: d.stages.map((s) => ({
              ...s,
              leads: s.id === to.id ? [{ ...lead, stageId: to.id }, ...s.leads] : s.leads.filter((l) => l.id !== lead.id),
              total: s.id === to.id ? s.total + 1 : s.id === lead.stageId ? s.total - 1 : s.total,
            })),
          }
        : d,
    );
    try {
      await api(`/leads/${lead.id}/move`, { body: { stageId: to.id } });
    } catch (err) {
      setData(before);
      toast(err instanceof Error ? err.message : "Couldn't move that lead.", "bad");
    }
  };

  const onDrop = (e: DragEvent, to: BoardStage) => {
    e.preventDefault();
    setOverId(null);
    const lead = stages.flatMap((s) => s.leads).find((l) => l.id === (dragId ?? e.dataTransfer.getData("text/plain")));
    setDragId(null);
    if (lead) void move(lead, to);
  };

  return (
    <>
      <PageHeader
        title="Leads"
        description={totalOpen ? `${totalOpen} open ${totalOpen === 1 ? "inquiry" : "inquiries"}. Drag a card to move it along, or open it for details.` : "Inquiries from your contact form and booking pages land here."}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add lead
          </Button>
        }
      />
      {error ? <Callout tone="bad" title="Couldn't load your leads">{error}</Callout> : null}

      {data === null && !error ? (
        <div className="board" aria-busy="true" aria-label="Loading leads">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="col">
              <div className="skeleton" style={{ height: 18, width: "50%" }} />
              <div className="skeleton" style={{ height: 70 }} />
              <div className="skeleton" style={{ height: 70 }} />
            </div>
          ))}
        </div>
      ) : null}

      {data && totalOpen === 0 && stages.every((s) => s.total === 0) ? (
        <EmptyState icon="lead" title="No leads yet" action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add your first lead</Button>}>
          When someone asks about a shoot, add them here and move them from first message to booked. Inquiries from your inquiry form land here on their own.
        </EmptyState>
      ) : data ? (
        <div className="board" role="list" aria-label="Lead pipeline">
          {stages.map((stage) => (
            <section
              key={stage.id}
              role="listitem"
              aria-label={stage.name}
              className={`col ${stage.kind}${overId === stage.id ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(stage.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverId((o) => (o === stage.id ? null : o));
              }}
              onDrop={(e) => onDrop(e, stage)}
            >
              <div className="col-head">
                <span>{stage.name}</span>
                <span className="count">{stage.total}</span>
              </div>
              {stage.leads.map((lead) => (
                <Link
                  key={lead.id}
                  to={`/studio/leads/${lead.id}`}
                  className={`card${dragId === lead.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    setDragId(lead.id);
                    e.dataTransfer.setData("text/plain", lead.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                >
                  <b>{lead.name}</b>
                  <span className="meta">
                    {lead.shootType ? <StatusChip>{lead.shootType}</StatusChip> : null}
                    {lead.eventDate ? (
                      <span>
                        <Icon name="calendar" width={14} height={14} style={{ verticalAlign: "-2px" }} /> {formatDate(new Date(`${lead.eventDate}T12:00:00Z`).getTime(), "UTC", { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    ) : null}
                  </span>
                  <span className="meta">
                    {lead.source ? `${lead.source} · ` : ""}
                    {relative(new Date(lead.createdAt).getTime())}
                  </span>
                </Link>
              ))}
              {stage.leads.length === 0 ? <div className="col-empty">{stage.kind === "won" ? "Booked leads appear here" : stage.kind === "lost" ? "Nothing lost. Nice." : "Drop a lead here"}</div> : null}
              {stage.total > stage.leads.length ? <p className="hint" style={{ textAlign: "center" }}>Showing the latest {stage.leads.length} of {stage.total}</p> : null}
            </section>
          ))}
        </div>
      ) : null}

      <NewLeadDialog
        open={adding}
        onClose={closeNew}
        onCreated={async (id) => {
          closeNew();
          toast("Lead added");
          navigate(`/studio/leads/${id}`);
        }}
      />
      <LoseDialog
        lead={losing}
        onClose={() => setLosing(null)}
        onDone={async () => {
          setLosing(null);
          await reload();
        }}
      />
    </>
  );
}

function LoseDialog({ lead, onClose, onDone }: { lead: LeadCard | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, submit } = useSubmit(() => api(`/leads/${lead?.id}/lose`, { body: { reason } }));
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (await submit()) {
      setReason("");
      onDone();
    }
  };
  return (
    <Dialog
      open={lead !== null}
      onClose={onClose}
      title={`Mark ${lead?.name ?? "this lead"} as lost?`}
      description="It moves to Lost and keeps its history. You can reopen it later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep open
          </Button>
          <Button variant="primary" type="submit" form="lose-form" loading={busy}>
            Mark as lost
          </Button>
        </>
      }
    >
      <form id="lose-form" onSubmit={go} noValidate>
        {error ? <Callout tone="bad">{error}</Callout> : null}
        <Field label="Why? (optional)" hint="Price, date taken, went elsewhere… helps you spot patterns.">
          {(p) => <TextInput {...p} autoComplete="off" autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

export function NewLeadDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (leadId: string) => void }) {
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [shootTypeId, setShootTypeId] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [source, setSource] = useState("");
  const [message, setMessage] = useState("");
  const { data: types } = useLoad<{ types: ShootType[] }>(open ? "/shoot-types" : null);
  const { busy, error, fieldErrors, submit } = useSubmit(() =>
    api<{ lead: { id: string } }>("/leads", { body: { contactId: contact?.id, shootTypeId: shootTypeId || null, eventDate: eventDate || null, source, message } }),
  );
  const reset = () => {
    setContact(null);
    setShootTypeId("");
    setEventDate("");
    setSource("");
    setMessage("");
  };
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!contact) return;
    const res = await submit();
    if (res) {
      reset();
      onCreated(res.lead.id);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a lead"
      description="Someone who's asked about a shoot but hasn't booked yet."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="lead-form" loading={busy} disabled={!contact}>
            Add lead
          </Button>
        </>
      }
    >
      <form id="lead-form" onSubmit={go} noValidate className="form-grid">
        {error ? (
          <div className="span-2">
            <Callout tone="bad">{error}</Callout>
          </div>
        ) : null}
        <div className="span-2">
          <ContactPicker value={contact} onChange={setContact} />
        </div>
        <Field label="Type of shoot" error={fieldErrors.shootTypeId}>
          {(p) => (
            <select {...p} className="input" value={shootTypeId} onChange={(e) => setShootTypeId(e.target.value)}>
              <option value="">Not sure yet</option>
              {types?.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Date they have in mind" error={fieldErrors.eventDate}>
          {(p) => <TextInput {...p} type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />}
        </Field>
        <Field className="span-2" label="Where did they find you?" hint="Referral, Instagram, Google…">
          {(p) => <TextInput {...p} autoComplete="off" value={source} maxLength={120} onChange={(e) => setSource(e.target.value)} />}
        </Field>
        <Field className="span-2" label="What did they say?" hint="Paste their message so it's all in one place.">
          {(p) => <TextArea {...p} rows={3} value={message} maxLength={10000} onChange={(e) => setMessage(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
