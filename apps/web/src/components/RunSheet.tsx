import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Callout, Dialog, EmptyState, Field, Spinner, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { useSubmit } from "../lib/useForm.js";
import { useLoad } from "../lib/useLoad.js";

export interface RunItem {
  id: string;
  shootId: string;
  startMinutes: number;
  durationMinutes: number | null;
  title: string;
  location: string | null;
  notes: string | null;
}

/** 930 as "15:30" for a time input. */
export const minutesToInput = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const inputToMinutes = (v: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
/** 930 as "3:30 PM". */
export const clock = (m: number) => {
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
export const lasts = (d: number) => (d % 60 === 0 ? `${d / 60} hr` : d > 60 ? `${Math.floor(d / 60)} hr ${d % 60} min` : `${d} min`);

/** The shoot's day-of timeline: add, edit and remove lines. Printing opens the run sheet page. */
export function RunSheetPanel({ shootId }: { shootId: string }) {
  const { data, error, loading, reload } = useLoad<{ items: RunItem[] }>(`/shoots/${shootId}/run-sheet`);
  const [editing, setEditing] = useState<RunItem | "new" | null>(null);
  const items = data?.items ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Day-of timeline</h2>
          <p>What happens when, for the day. Print it as a run sheet.</p>
        </div>
        <div className="actions">
          {items.length ? (
            <Link className="btn sm" to={`/studio/shoots/${shootId}/run-sheet`}>
              Print run sheet
            </Link>
          ) : null}
          <Button size="sm" icon="plus" onClick={() => setEditing("new")}>
            Add a line
          </Button>
        </div>
      </div>
      <div className="panel-body">
        {error ? <Callout tone="bad">{error}</Callout> : null}
        {loading && !data ? <Spinner label="Loading the timeline" /> : null}
        {data && items.length === 0 ? (
          <EmptyState icon="clock" title="No timeline yet">
            Add the hour-by-hour plan: getting ready, the first look, portraits, and when to wrap up.
          </EmptyState>
        ) : null}
        <ol className="run-list">
          {items.map((it) => (
            <li key={it.id} className="run-row">
              <div className="run-time">
                <b>{clock(it.startMinutes)}</b>
                {it.durationMinutes ? <span>{lasts(it.durationMinutes)}</span> : null}
              </div>
              <div className="run-what">
                <b>{it.title}</b>
                {it.location ? <span>{it.location}</span> : null}
                {it.notes ? <p>{it.notes}</p> : null}
              </div>
              <Button size="sm" variant="ghost" className="icon" icon="edit" aria-label={`Edit ${it.title}`} onClick={() => setEditing(it)} />
            </li>
          ))}
        </ol>
      </div>
      <RunItemDialog target={editing} shootId={shootId} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
    </section>
  );
}

function RunItemDialog({ target, shootId, onClose, onSaved }: { target: RunItem | "new" | null; shootId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const existing = target && target !== "new" ? target : null;
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (!target) return;
    setTime(existing ? minutesToInput(existing.startMinutes) : "");
    setDuration(existing?.durationMinutes ? String(existing.durationMinutes) : "");
    setTitle(existing?.title ?? "");
    setLocation(existing?.location ?? "");
    setNotes(existing?.notes ?? "");
  }, [target, existing]);

  const { busy, error, submit } = useSubmit(async () => {
    const startMinutes = inputToMinutes(time);
    if (!Number.isFinite(startMinutes)) throw new Error("Choose a time.");
    const d = duration.trim() ? Number(duration) : null;
    if (d !== null && (!Number.isInteger(d) || d < 1)) throw new Error("Enter the length in whole minutes, or leave it blank.");
    const body = { startMinutes, durationMinutes: d, title, location, notes };
    if (existing) await api(`/shoots/${shootId}/run-sheet/${existing.id}`, { method: "PATCH", body });
    else await api(`/shoots/${shootId}/run-sheet`, { body });
    return true;
  });
  const remove = useSubmit(() => api(`/shoots/${shootId}/run-sheet/${existing?.id}`, { method: "DELETE" }));
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (await submit()) {
      toast(existing ? "Line saved" : "Line added");
      onSaved();
    }
  };
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={existing ? "Edit this line" : "Add a line"}
      footer={
        <>
          {existing ? (
            <Button variant="ghost" className="danger" loading={remove.busy} style={{ marginRight: "auto" }} onClick={async () => { if ((await remove.submit()) !== undefined) { toast("Line removed"); onSaved(); } }}>
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="run-form" loading={busy} disabled={!time || !title.trim()}>
            {existing ? "Save" : "Add line"}
          </Button>
        </>
      }
    >
      <form id="run-form" onSubmit={go} noValidate className="form-grid">
        {error || remove.error ? (
          <div className="span-2">
            <Callout tone="bad">{error ?? remove.error}</Callout>
          </div>
        ) : null}
        <Field label="Time" hint="Your studio's time zone.">
          {(p) => <TextInput {...p} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
        </Field>
        <Field label="Minutes" hint="Optional.">
          {(p) => <TextInput {...p} inputMode="numeric" autoComplete="off" value={duration} maxLength={4} onChange={(e) => setDuration(e.target.value.replace(/\D/g, ""))} />}
        </Field>
        <Field className="span-2" label="What happens">
          {(p) => <TextInput {...p} autoComplete="off" value={title} maxLength={160} placeholder="First look at the pier" onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field className="span-2" label="Where" hint="Optional.">
          {(p) => <TextInput {...p} autoComplete="off" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />}
        </Field>
        <Field className="span-2" label="Notes" hint="Optional. Shots to get, who needs to be there, props.">
          {(p) => <textarea {...p} className="input" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
