import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Button, Callout, Dialog, Field, Icon, Panel, StatusChip, TextArea, TextInput, copyText, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDate, formatTime, ms, msToZoned, zonedToMs } from "../../lib/time.js";
import { SHOOT_STATUS, type ShootDetail, type ShootEvent, type ShootStatus, type ShootType } from "../../lib/types.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { ShootQuestionnaires } from "./ShootQuestionnaires.js";

export function ShootDetailPage() {
  const { id = "" } = useParams();
  const toast = useToast();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const { data: shoot, error, setData, reload } = useLoad<ShootDetail>(`/shoots/${id}`);
  const [editingEvent, setEditingEvent] = useState<ShootEvent | "new" | null>(null);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [folderProblem, setFolderProblem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (shoot && notes === null) setNotes(shoot.notes ?? "");
  }, [shoot, notes]);

  const patch = async (body: Record<string, unknown>, done?: string) => {
    try {
      const next = await api<ShootDetail>(`/shoots/${id}`, { method: "PATCH", body });
      setData(next);
      if (done) toast(done);
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't save.", "bad");
      return false;
    }
  };

  const retryFolder = async () => {
    setRenaming(true);
    try {
      setData(await api<ShootDetail>(`/shoots/${id}/rename-folder`, { method: "POST" }));
      setFolderProblem(null);
      toast("Folder created");
    } catch (err) {
      setFolderProblem(err instanceof Error ? err.message : "The folder couldn't be created.");
    } finally {
      setRenaming(false);
    }
  };

  if (error)
    return (
      <>
        <Link to="/studio/shoots" className="back">
          <Icon name="arrowLeft" /> Shoots
        </Link>
        <Callout tone="bad" title="Couldn't open this shoot">{error}</Callout>
      </>
    );
  if (!shoot)
    return (
      <div className="stack" aria-busy="true">
        <div className="skeleton" style={{ height: 22, width: 70 }} />
        <div className="skeleton" style={{ height: 40, width: "40%" }} />
        <div className="skeleton" style={{ height: 220 }} />
      </div>
    );

  const folder = shoot.folder;
  const hasDate = shoot.events.length > 0;
  const notesDirty = notes !== null && notes !== (shoot.notes ?? "");

  return (
    <>
      <Link to="/studio/shoots" className="back">
        <Icon name="arrowLeft" /> Shoots
      </Link>
      <header className="page-head">
        <div>
          <h1 style={{ overflowWrap: "anywhere" }}>{shoot.subject}</h1>
          <div className="facts">
            <span>{shoot.shootType.name}</span>
            <Link to={`/studio/clients/${shoot.primary.id}`}>
              <Icon name="user" /> {shoot.primary.name}
            </Link>
            {hasDate ? (
              <span>
                <Icon name="calendar" /> {formatDate(ms(shoot.events[0]!.startsAt), tz)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="actions">
          <Button icon="edit" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <select className="input" aria-label="Status" style={{ width: "auto" }} value={shoot.status} onChange={(e) => void patch({ status: e.target.value as ShootStatus }, "Status updated")}>
            {(Object.keys(SHOOT_STATUS) as ShootStatus[]).map((s) => (
              <option key={s} value={s}>
                {SHOOT_STATUS[s].label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="split">
        <div className="stack">
          <Panel
            title="When and where"
            actions={
              <Button size="sm" icon="plus" onClick={() => setEditingEvent("new")}>
                Add a time
              </Button>
            }
          >
            {!hasDate ? (
              <Callout tone="info" title="No date yet">Add one to create this shoot's folder and put it on the calendar.</Callout>
            ) : (
              <div>
                {shoot.events.map((ev) => (
                  <div key={ev.id} className="event">
                    <div className="when">
                      <b>
                        {ev.title ? `${ev.title}: ` : ""}
                        {formatDate(ms(ev.startsAt), tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                      </b>
                      <span>
                        {ev.allDay ? "All day" : `${formatTime(ms(ev.startsAt), tz)} to ${formatTime(ms(ev.endsAt), tz)}`}
                        {ev.location ? ` · ${ev.location}` : ""}
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" className="icon" icon="edit" aria-label="Edit this time" onClick={() => setEditingEvent(ev)} />
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <ShootQuestionnaires shootId={id} clientEmail={shoot.primary.email} />

          <Panel title="Notes">
            <TextArea aria-label="Shoot notes" rows={4} placeholder="Shot list, location details, what the client asked for…" value={notes ?? ""} maxLength={10000} onChange={(e) => setNotes(e.target.value)} />
            {notesDirty ? (
              <div className="form-actions">
                <Button variant="ghost" size="sm" onClick={() => setNotes(shoot.notes ?? "")}>
                  Discard
                </Button>
                <Button variant="primary" size="sm" onClick={async () => { await patch({ notes }, "Notes saved"); }}>
                  Save notes
                </Button>
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Photo folder" description="Where exports go so they show up in this shoot's gallery.">
            {folder ? (
              <div className="folder-path">
                <div className="tree" aria-label="Folder layout">
                  <span>{folder.path}/</span>
                  <span className="sub">
                    {folder.rawSubdir}/<small>camera files</small>
                  </span>
                  <span className="sub">
                    {folder.deliverySubdir}/<small>exports for the gallery</small>
                  </span>
                </div>
                {!folder.exists ? <Callout tone="warn" title="The folder isn't on the share">It may have been moved or deleted. Recreate it to export here again.</Callout> : null}
                <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                  <Button size="sm" icon="copy" onClick={() => { void copyText(folder.path).then((ok) => toast(ok ? "Folder name copied" : "Couldn't copy. Select the name and copy it yourself.", ok ? "ok" : "bad")); }}>
                    Copy folder name
                  </Button>
                  <Button size="sm" icon="folder" loading={renaming} onClick={retryFolder}>
                    {folder.exists ? "Rename to pattern" : "Recreate folder"}
                  </Button>
                </div>
                <p className="hint">Editing the subject or date never renames this folder by itself, so export presets keep working.</p>
              </div>
            ) : hasDate ? (
              <>
                <Callout tone="warn" title="The folder wasn't created">{folderProblem ?? "Something stopped OpenPortrait writing to your gallery share."}</Callout>
                <Button icon="refresh" loading={renaming} onClick={retryFolder}>
                  Try again
                </Button>
              </>
            ) : (
              <p className="hint">The folder is created as soon as this shoot has a date.</p>
            )}
          </Panel>

          <Panel title="Client">
            <div className="facts" style={{ flexDirection: "column", margin: 0 }}>
              <Link to={`/studio/clients/${shoot.primary.id}`} style={{ fontWeight: 600 }}>
                {shoot.primary.name}
              </Link>
              {shoot.primary.email ? (
                <a href={`mailto:${shoot.primary.email}`}>
                  <Icon name="mail" /> {shoot.primary.email}
                </a>
              ) : null}
              {shoot.primary.phone ? (
                <a href={`tel:${shoot.primary.phone}`}>
                  <Icon name="phone" /> {shoot.primary.phone}
                </a>
              ) : null}
            </div>
          </Panel>
          {shoot.status === "cancelled" ? <StatusChip tone="neutral">Cancelled</StatusChip> : null}
        </div>
      </div>

      <EventDialog
        target={editingEvent}
        shootId={id}
        tz={tz}
        onClose={() => setEditingEvent(null)}
        onSaved={async (folderError) => {
          setEditingEvent(null);
          if (folderError) setFolderProblem(folderError);
          await reload();
        }}
      />
      <EditShootDialog open={editing} shoot={shoot} onClose={() => setEditing(false)} onSaved={(s) => { setData(s); setEditing(false); toast("Shoot saved"); }} />
    </>
  );
}

function EventDialog({ target, shootId, tz, onClose, onSaved }: { target: ShootEvent | "new" | null; shootId: string; tz: string; onClose: () => void; onSaved: (folderError: string | null) => void }) {
  const existing = target && target !== "new" ? target : null;
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [location, setLocation] = useState("");
  useEffect(() => {
    if (!target) return;
    if (existing) {
      setTitle(existing.title);
      setStart(msToZoned(ms(existing.startsAt), tz));
      setEnd(msToZoned(ms(existing.endsAt), tz));
      setLocation(existing.location ?? "");
    } else {
      setTitle("");
      setStart("");
      setEnd("");
      setLocation("");
    }
  }, [target, existing, tz]);

  const { busy, error, submit } = useSubmit(async () => {
    const startsAt = zonedToMs(start, tz);
    const endsAt = end ? zonedToMs(end, tz) : startsAt + 3_600_000;
    if (!Number.isFinite(startsAt)) throw new Error("Choose a start time.");
    const body = { title, startsAt, endsAt, location };
    if (existing) {
      await api(`/shoots/${shootId}/events/${existing.id}`, { method: "PATCH", body });
      return null;
    }
    return (await api<{ folderError: string | null }>(`/shoots/${shootId}/events`, { body })).folderError;
  });
  const remove = useSubmit(() => api(`/shoots/${shootId}/events/${existing?.id}`, { method: "DELETE" }));

  const go = async (e: FormEvent) => {
    e.preventDefault();
    const res = await submit();
    if (res !== undefined) onSaved(res);
  };

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={existing ? "Edit this time" : "Add a time"}
      description="Weddings often have several: getting ready, the ceremony, portraits."
      footer={
        <>
          {existing ? (
            <Button variant="ghost" className="danger" loading={remove.busy} onClick={async () => { if ((await remove.submit()) !== undefined) onSaved(null); }} style={{ marginRight: "auto" }}>
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="event-form" loading={busy} disabled={!start}>
            {existing ? "Save" : "Add time"}
          </Button>
        </>
      }
    >
      <form id="event-form" onSubmit={go} noValidate className="form-grid">
        {error || remove.error ? (
          <div className="span-2">
            <Callout tone="bad">{error ?? remove.error}</Callout>
          </div>
        ) : null}
        <Field className="span-2" label="What's happening" hint="Optional, such as “Ceremony”.">
          {(p) => <TextInput {...p} autoComplete="off" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Starts" hint="Your studio's time zone.">
          {(p) => <TextInput {...p} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}
        </Field>
        <Field label="Ends" hint="Defaults to an hour later.">
          {(p) => <TextInput {...p} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />}
        </Field>
        <Field className="span-2" label="Location">
          {(p) => <TextInput {...p} autoComplete="off" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

function EditShootDialog({ open, shoot, onClose, onSaved }: { open: boolean; shoot: ShootDetail; onClose: () => void; onSaved: (s: ShootDetail) => void }) {
  const [subject, setSubject] = useState(shoot.subject);
  const [typeId, setTypeId] = useState(shoot.shootType.id);
  const { data: types } = useLoad<{ types: ShootType[] }>(open ? "/shoot-types" : null);
  useEffect(() => {
    if (open) {
      setSubject(shoot.subject);
      setTypeId(shoot.shootType.id);
    }
  }, [open, shoot]);
  const { busy, error, submit } = useSubmit(() => api<ShootDetail>(`/shoots/${shoot.id}`, { method: "PATCH", body: { subject, shootTypeId: typeId } }));
  const go = async (e: FormEvent) => {
    e.preventDefault();
    const res = await submit();
    if (res) onSaved(res);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit shoot"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="edit-shoot" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-shoot" onSubmit={go} noValidate className="form-grid">
        {error ? (
          <div className="span-2">
            <Callout tone="bad">{error}</Callout>
          </div>
        ) : null}
        <Field className="span-2" label="Who's being photographed" hint="The folder keeps its current name until you choose “Rename to match the pattern”.">
          {(p) => <TextInput {...p} autoComplete="off" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />}
        </Field>
        <Field className="span-2" label="Type of shoot">
          {(p) => (
            <select {...p} className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types?.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              {types && !types.types.some((t) => t.id === shoot.shootType.id) ? <option value={shoot.shootType.id}>{shoot.shootType.name} (archived)</option> : null}
            </select>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

