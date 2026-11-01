import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, Field, Switch, TextArea, TextInput } from "@openportrait/ui";
import { ContactPicker, type PickedContact } from "../../components/ContactPicker.js";
import { api } from "../../lib/api.js";
import { addDays, dayStart, ymdOf, type CalendarItem, type Ymd } from "../../lib/calendar.js";
import { msToZoned, zonedToMs } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";

export type EntryTarget = { mode: "new"; ymd: Ymd } | { mode: "edit"; item: CalendarItem } | null;

/** Add or edit an appointment (something with a client) or a personal block (time you're not available). */
export function EntryDialog({ target, tz, onClose, onSaved }: { target: EntryTarget; tz: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [kind, setKind] = useState<"appointment" | "block">("appointment");
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [contact, setContact] = useState<PickedContact | null>(null);

  useEffect(() => {
    if (!target) return;
    if (target.mode === "new") {
      setKind("appointment");
      setTitle("");
      setAllDay(false);
      setStart(`${target.ymd}T09:00`);
      setEnd(`${target.ymd}T10:00`);
      setLocation("");
      setNotes("");
      setContact(null);
      return;
    }
    const i = target.item;
    setKind(i.source === "block" ? "block" : "appointment");
    setTitle(i.title);
    setAllDay(i.allDay);
    if (i.allDay) {
      setStart(ymdOf(i.startsAt, tz));
      setEnd(addDays(ymdOf(i.endsAt, tz), -1));
    } else {
      setStart(msToZoned(i.startsAt, tz));
      setEnd(msToZoned(i.endsAt, tz));
    }
    setLocation(i.location ?? "");
    setNotes(i.notes ?? "");
    setContact(i.contactId && i.contactName ? { id: i.contactId, name: i.contactName } : null);
  }, [target, tz]);

  const toggleAllDay = (on: boolean) => {
    setAllDay(on);
    setStart((s) => (on ? s.slice(0, 10) : `${s.slice(0, 10)}T09:00`));
    setEnd((e) => (on ? e.slice(0, 10) : `${e.slice(0, 10)}T10:00`));
  };

  const editing = target?.mode === "edit" ? target.item : null;
  const { busy, error, submit } = useSubmit(async () => {
    if (!title.trim()) throw new Error("Give it a title.");
    let startsAt: number;
    let endsAt: number;
    if (allDay) {
      if (!start) throw new Error("Choose a date.");
      startsAt = dayStart(start, tz);
      const last = end && end >= start ? end : start;
      endsAt = dayStart(addDays(last, 1), tz);
    } else {
      startsAt = zonedToMs(start, tz);
      endsAt = end ? zonedToMs(end, tz) : startsAt + 3_600_000;
      if (!Number.isFinite(startsAt)) throw new Error("Choose a start time.");
      if (endsAt < startsAt) throw new Error("The end can't be before the start.");
    }
    const body = { kind, title, startsAt, endsAt, allDay, location: location || null, notes: notes || null, contactId: kind === "appointment" ? (contact?.id ?? null) : null };
    if (editing) await api(`/calendar/entries/${editing.id}`, { method: "PATCH", body });
    else await api("/calendar/entries", { body });
    return true;
  });
  const remove = useSubmit(async () => {
    await api(`/calendar/entries/${editing?.id}`, { method: "DELETE" });
    return true;
  });

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (await submit()) onSaved(editing ? "Saved." : kind === "block" ? "Time blocked off." : "Appointment added.");
  };

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={editing ? (kind === "block" ? "Edit blocked time" : "Edit appointment") : "Add to the calendar"}
      description={kind === "block" ? "Keeps this time free of bookings." : "A call, consult or pickup. Shoots are added from the shoot itself."}
      footer={
        <>
          {editing ? (
            <Button variant="ghost" className="danger" loading={remove.busy} style={{ marginRight: "auto" }} onClick={async () => { if (await remove.submit()) onSaved("Removed."); }}>
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="entry-form" loading={busy}>
            {editing ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form id="entry-form" onSubmit={go} noValidate className="form-grid">
        {error || remove.error ? (
          <div className="span-2">
            <Callout tone="bad">{error ?? remove.error}</Callout>
          </div>
        ) : null}
        <div className="span-2 seg" role="group" aria-label="Type">
          <button type="button" aria-pressed={kind === "appointment"} onClick={() => setKind("appointment")}>
            Appointment
          </button>
          <button type="button" aria-pressed={kind === "block"} onClick={() => setKind("block")}>
            Time off
          </button>
        </div>
        <Field className="span-2" label="Title">
          {(p) => <TextInput {...p} autoComplete="off" autoFocus value={title} maxLength={160} placeholder={kind === "block" ? "Vacation, school run, editing day" : "Consult call with Dana"} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <div className="span-2">
          <Switch checked={allDay} onChange={toggleAllDay} label="All day" />
        </div>
        <Field label={allDay ? "First day" : "Starts"} hint={allDay ? undefined : "Your studio's time zone."}>
          {(p) => <TextInput {...p} type={allDay ? "date" : "datetime-local"} value={start} onChange={(e) => setStart(e.target.value)} />}
        </Field>
        <Field label={allDay ? "Last day" : "Ends"} hint={allDay ? "Leave as is for a single day." : "Defaults to an hour later."}>
          {(p) => <TextInput {...p} type={allDay ? "date" : "datetime-local"} value={end} onChange={(e) => setEnd(e.target.value)} />}
        </Field>
        {kind === "appointment" ? (
          <>
            <Field className="span-2" label="Where" hint="Optional, such as a phone number or address.">
              {(p) => <TextInput {...p} autoComplete="off" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />}
            </Field>
            <div className="span-2">
              <ContactPicker label="With (optional)" value={contact} onChange={setContact} />
            </div>
          </>
        ) : null}
        <Field className="span-2" label="Notes" hint="Optional.">
          {(p) => <TextArea {...p} rows={3} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
