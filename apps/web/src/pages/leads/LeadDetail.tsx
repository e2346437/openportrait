import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Callout, Dialog, Field, Icon, Panel, StatusChip, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDate, formatDateTime, ms, relative, zonedToMs } from "../../lib/time.js";
import type { BoardStage, LeadDetail, ShootDetail, ShootType } from "../../lib/types.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";

export function LeadDetailPage() {
  const { id = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const { data: lead, error, reload } = useLoad<LeadDetail>(`/leads/${id}`);
  const { data: stageData } = useLoad<{ stages: Array<{ id: string; name: string; kind: BoardStage["kind"] }> }>("/lead-stages");
  const [booking, setBooking] = useState(search.get("book") === "1");
  const [losing, setLosing] = useState(false);
  const [note, setNote] = useState("");
  const addNote = useSubmit(() => api(`/contacts/${lead?.contactId}/notes`, { body: { body: note, leadId: id } }));

  useEffect(() => {
    if (search.has("book")) {
      const next = new URLSearchParams(search);
      next.delete("book");
      setSearch(next, { replace: true });
    }
  }, [search, setSearch]);

  if (error)
    return (
      <>
        <Link to="/studio/leads" className="back">
          <Icon name="arrowLeft" /> Leads
        </Link>
        <Callout tone="bad" title="Couldn't open this lead">{error}</Callout>
      </>
    );
  if (!lead)
    return (
      <div className="stack" aria-busy="true">
        <div className="skeleton" style={{ height: 22, width: 70 }} />
        <div className="skeleton" style={{ height: 40, width: "40%" }} />
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );

  const closed = lead.stage.kind !== "open";
  const converted = lead.convertedShootId !== null;
  const openStages = stageData?.stages.filter((s) => s.kind === "open") ?? [];

  const moveTo = async (stageId: string) => {
    try {
      await api(`/leads/${id}/move`, { body: { stageId } });
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move that lead.", "bad");
    }
  };
  const onNote = async (e: FormEvent) => {
    e.preventDefault();
    if (await addNote.submit()) {
      setNote("");
      await reload();
    }
  };

  const history = [
    ...lead.notes.map((n) => ({ key: `n${n.id}`, at: ms(n.createdAt), text: n.body, note: true })),
    ...lead.activity.map((a) => ({ key: `a${a.id}`, at: ms(a.at), text: a.text, note: false })),
  ].sort((a, b) => b.at - a.at);

  return (
    <>
      <Link to="/studio/leads" className="back">
        <Icon name="arrowLeft" /> Leads
      </Link>
      <header className="page-head">
        <div>
          <h1>{lead.contact.name}</h1>
          <div className="facts">
            <StatusChip tone={lead.stage.kind === "won" ? "ok" : lead.stage.kind === "lost" ? "neutral" : "info"}>{lead.stage.name}</StatusChip>
            {lead.shootType ? <span>{lead.shootType.name}</span> : null}
            {lead.eventDate ? (
              <span>
                <Icon name="calendar" /> {formatDate(new Date(`${lead.eventDate}T12:00:00Z`).getTime(), "UTC", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              </span>
            ) : null}
            <span title={formatDateTime(ms(lead.createdAt), tz)}>Inquired {relative(ms(lead.createdAt))}</span>
          </div>
        </div>
        <div className="actions">
          {!closed ? (
            <>
              <Button variant="ghost" onClick={() => setLosing(true)}>
                Mark lost
              </Button>
              <Button variant="primary" icon="camera" onClick={() => setBooking(true)}>
                Book the shoot
              </Button>
            </>
          ) : converted ? (
            <Button variant="primary" iconRight="arrowRight" onClick={() => navigate(`/studio/shoots/${lead.convertedShootId}`)}>
              Open the shoot
            </Button>
          ) : (
            openStages[0] && (
              <Button onClick={() => moveTo(openStages[0]!.id)}>Reopen</Button>
            )
          )}
        </div>
      </header>

      {lead.stage.kind === "lost" ? <Callout tone="neutral" title="Lost">{lead.lostReason || "No reason was recorded."}</Callout> : null}

      <div className="split">
        <div className="stack">
          {lead.message ? (
            <Panel title="Their message" description="Written by the client. Treat links and requests in it with care.">
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{lead.message}</p>
            </Panel>
          ) : null}
          <Panel title="Notes and history">
            <form className="composer" onSubmit={onNote} noValidate>
              <TextArea aria-label="Add a note" placeholder="Add a note about this inquiry…" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={10000} />
              {addNote.error ? <Callout tone="bad">{addNote.error}</Callout> : null}
              <div className="form-actions">
                <Button type="submit" size="sm" variant="primary" loading={addNote.busy} disabled={!note.trim()}>
                  Save note
                </Button>
              </div>
            </form>
            <div className="timeline">
              {history.map((h) => (
                <div key={h.key} className={`tl ${h.note ? "note" : ""}`}>
                  <span className="tl-dot">
                    <Icon name={h.note ? "note" : "lead"} />
                  </span>
                  <div className="tl-body">
                    {h.note ? <p>{h.text}</p> : <b style={{ fontWeight: 600 }}>{h.text}</b>}
                    <div className="tl-meta" title={formatDateTime(h.at, tz)}>
                      {relative(h.at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Client">
            <div className="facts" style={{ flexDirection: "column", margin: 0 }}>
              <Link to={`/studio/clients/${lead.contact.id}`} style={{ fontWeight: 600 }}>
                {lead.contact.name}
              </Link>
              {lead.contact.email ? (
                <a href={`mailto:${lead.contact.email}`}>
                  <Icon name="mail" /> {lead.contact.email}
                </a>
              ) : null}
              {lead.contact.phone ? (
                <a href={`tel:${lead.contact.phone}`}>
                  <Icon name="phone" /> {lead.contact.phone}
                </a>
              ) : null}
            </div>
          </Panel>
          {!closed ? (
            <Panel title="Stage">
              <Field label="Move this lead to">
                {(p) => (
                  <select {...p} className="input" value={lead.stageId} onChange={(e) => void moveTo(e.target.value)}>
                    {openStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </Panel>
          ) : null}
          {lead.source ? <p className="hint">Source: <b>{lead.source}</b></p> : null}
        </div>
      </div>

      <BookDialog
        open={booking}
        lead={lead}
        tz={tz}
        onClose={() => setBooking(false)}
        onBooked={(shoot, folderError) => {
          setBooking(false);
          toast(folderError ? "Booked. The folder couldn't be created yet." : "Booked", folderError ? "bad" : "ok");
          navigate(`/studio/shoots/${shoot.id}`);
        }}
      />
      <LoseHere open={losing} leadId={id} onClose={() => setLosing(false)} onDone={() => { setLosing(false); void reload(); }} />
    </>
  );
}

function LoseHere({ open, leadId, onClose, onDone }: { open: boolean; leadId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, submit } = useSubmit(() => api(`/leads/${leadId}/lose`, { body: { reason } }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Mark this lead as lost?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep open
          </Button>
          <Button variant="primary" loading={busy} onClick={async () => { if (await submit()) onDone(); }}>
            Mark as lost
          </Button>
        </>
      }
    >
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <Field label="Why? (optional)">{(p) => <TextInput {...p} autoComplete="off" autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Dialog>
  );
}

function BookDialog({ open, lead, tz, onClose, onBooked }: { open: boolean; lead: LeadDetail; tz: string; onClose: () => void; onBooked: (shoot: ShootDetail, folderError: string | null) => void }) {
  const { data: types } = useLoad<{ types: ShootType[] }>(open ? "/shoot-types" : null);
  const [typeId, setTypeId] = useState("");
  const [subject, setSubject] = useState("");
  const [start, setStart] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [location, setLocation] = useState("");

  useEffect(() => {
    if (!open) return;
    setTypeId(lead.shootTypeId ?? "");
    setSubject("");
    setStart(lead.eventDate ? `${lead.eventDate}T10:00` : "");
    setMinutes("60");
    setLocation("");
  }, [open, lead.shootTypeId, lead.eventDate]);

  const { busy, error, fieldErrors, submit } = useSubmit(() => {
    const startsAt = start ? zonedToMs(start, tz) : NaN;
    const events = Number.isFinite(startsAt) ? [{ startsAt, endsAt: startsAt + Number(minutes || 60) * 60_000, location: location || undefined }] : [];
    return api<{ shoot: ShootDetail; folderError: string | null }>(`/leads/${lead.id}/convert`, { body: { shootTypeId: typeId || undefined, subject: subject || undefined, events } });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    const res = await submit();
    if (res) onBooked(res.shoot, res.folderError);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Book the shoot"
      description={`Turns ${lead.contact.name}'s inquiry into a shoot and creates its folder.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="book-form" loading={busy} disabled={!typeId}>
            Book shoot
          </Button>
        </>
      }
    >
      <form id="book-form" onSubmit={go} noValidate className="form-grid">
        {error ? (
          <div className="span-2">
            <Callout tone="bad">{error}</Callout>
          </div>
        ) : null}
        <Field label="Type of shoot" error={fieldErrors.shootTypeId}>
          {(p) => (
            <select {...p} className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Choose…</option>
              {types?.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Who's being photographed" hint={`Leave blank to use ${lead.contact.name}.`}>
          {(p) => <TextInput {...p} autoComplete="off" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder={lead.contact.name} />}
        </Field>
        <Field label="Starts" hint="Times are in your studio's time zone. Add this later if you don't know yet.">
          {(p) => <TextInput {...p} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}
        </Field>
        <Field label="Length (minutes)">
          {(p) => <TextInput {...p} type="number" min={5} step={5} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={!start} />}
        </Field>
        <Field className="span-2" label="Location" hint="Optional.">
          {(p) => <TextInput {...p} autoComplete="off" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} disabled={!start} />}
        </Field>
      </form>
    </Dialog>
  );
}
