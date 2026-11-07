import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, Field, Icon, TextArea, TextInput } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { moneyInput, parseMoney } from "../../lib/money.js";
import { SwitchRow } from "../../components/SwitchRow.js";

export type Windows = Record<string, Array<{ start: string; end: string }>>;
export interface Scheduler {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  stepMinutes: number;
  location: string | null;
  shootTypeId: string | null;
  approval: "manual" | "auto";
  priceCents: number;
  depositType: "none" | "percent" | "fixed";
  depositValue: number;
  contractTemplateId: string | null;
  createShoot: boolean;
  maxPerDay: number;
  dateOverrides: Windows;
  availability: Windows;
  active: boolean;
}

// Monday first, since that's how most people think of a work week. Keys follow the server: 0 = Sunday.
const DAYS: Array<[string, string]> = [["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["0", "Sunday"]];
const WEEKDAYS = ["1", "2", "3", "4", "5"];

const blank = (): Scheduler => ({
  id: "",
  slug: "",
  name: "",
  description: "",
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  minNoticeHours: 24,
  maxDaysAhead: 60,
  stepMinutes: 30,
  location: "",
  shootTypeId: null,
  approval: "manual",
  priceCents: 0,
  depositType: "none",
  depositValue: 0,
  contractTemplateId: null,
  createShoot: false,
  maxPerDay: 0,
  dateOverrides: {},
  availability: Object.fromEntries(WEEKDAYS.map((d) => [d, [{ start: "09:00", end: "17:00" }]])),
  active: true,
});

/** Create or edit a booking page, including the weekly hours it offers. */
export function SchedulerDialog({ target, onClose, onSaved }: { target: Scheduler | "new" | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Scheduler>(blank());
  // Prices are typed in dollars; the server wants cents. Kept as text so half-typed values aren't mangled.
  const [price, setPrice] = useState("");
  const [deposit, setDeposit] = useState("");
  const types = useLoad<{ types: Array<{ id: string; name: string }> }>(target ? "/shoot-types" : null);
  const templates = useLoad<{ items: Array<{ id: string; name: string }> }>(target ? "/contract-templates" : null);
  useEffect(() => {
    if (!target) return;
    const t = target === "new" ? blank() : { ...target, description: target.description ?? "", location: target.location ?? "" };
    setF(t);
    setPrice(t.priceCents ? moneyInput(t.priceCents) : "");
    setDeposit(t.depositType === "percent" ? String(t.depositValue / 100) : t.depositType === "fixed" ? moneyInput(t.depositValue) : "");
  }, [target]);
  const num = (k: keyof Scheduler) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value === "" ? 0 : Number(e.target.value) }));
  const txt = (k: keyof Scheduler) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const editing = target && target !== "new" ? target : null;
  const { busy, error, fieldErrors, submit } = useSubmit(() => {
    const { id: _id, active: _a, ...rest } = f;
    const priceCents = price.trim() ? parseMoney(price) : 0;
    if (priceCents === null || priceCents < 0) throw new Error("Enter the price like 150.00, or leave it empty for a free page.");
    let depositValue = 0;
    if (priceCents > 0 && f.depositType !== "none") {
      const n = f.depositType === "percent" ? Number(deposit) : parseMoney(deposit);
      if (n === null || !Number.isFinite(n) || n <= 0) throw new Error(f.depositType === "percent" ? "Enter the retainer percentage, like 25." : "Enter the retainer amount, like 50.00.");
      depositValue = f.depositType === "percent" ? Math.round(n * 100) : n;
    }
    const body = {
      ...rest,
      priceCents,
      depositType: priceCents > 0 ? f.depositType : "none",
      depositValue,
      // Dates that have passed are dropped, so the list doesn't grow forever.
      dateOverrides: Object.fromEntries(Object.entries(f.dateOverrides ?? {}).filter(([d]) => d >= new Date().toISOString().slice(0, 10))),
      createShoot: !!f.shootTypeId && f.createShoot,
      contractTemplateId: priceCents > 0 ? f.contractTemplateId || null : null,
      active: f.active, description: f.description || null, location: f.location || null, shootTypeId: f.shootTypeId || null, slug: f.slug || undefined };
    return editing ? api(`/schedulers/${editing.id}`, { method: "PATCH", body }) : api("/schedulers", { body });
  });
  const remove = async () => {
    if (!editing || !window.confirm(`Delete "${editing.name}"? Its link stops working. Existing bookings stay on your calendar.`)) return;
    await api(`/schedulers/${editing.id}`, { method: "DELETE" });
    onSaved();
  };
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) onSaved();
  };

  const overrides = Object.entries(f.dateOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const setOverride = (date: string, windows: Array<{ start: string; end: string }> | null, was?: string) =>
    setF((x) => {
      const next = { ...x.dateOverrides };
      if (was !== undefined) delete next[was];
      if (windows) next[date] = windows;
      return { ...x, dateOverrides: next };
    });
  const setDay = (d: string, windows: Array<{ start: string; end: string }>) => setF((x) => ({ ...x, availability: { ...x.availability, [d]: windows } }));

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      wide
      title={editing ? "Edit booking page" : "New booking page"}
      footer={
        <>
          {editing ? <Button variant="ghost" className="danger" onClick={remove} style={{ marginRight: "auto" }}>Delete</Button> : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="sched-form" type="submit" loading={busy}>{editing ? "Save" : "Create page"}</Button>
        </>
      }
    >
      <form id="sched-form" onSubmit={onSubmit} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field className="span-2" label="Name" hint="What clients see, such as “30-minute consult”." error={fieldErrors.name}>
          {(p) => <TextInput {...p} value={f.name} onChange={txt("name")} autoFocus={!editing} />}
        </Field>
        <Field className="span-2" label="Description" hint="Optional.">
          {(p) => <TextArea {...p} rows={2} maxLength={2000} value={f.description ?? ""} onChange={txt("description")} />}
        </Field>
        <Field label="Length (minutes)">{(p) => <TextInput {...p} inputMode="numeric" value={f.durationMinutes} onChange={num("durationMinutes")} />}</Field>
        <Field label="Location" hint="Optional. Address or “Video call”.">{(p) => <TextInput {...p} value={f.location ?? ""} onChange={txt("location")} />}</Field>

        <fieldset className="span-2 week-edit">
          <legend>Weekly hours</legend>
          {DAYS.map(([d, label]) => {
            const w = f.availability[d] ?? [];
            return (
              <div key={d} className="week-row">
                <label className="week-day">
                  <input type="checkbox" checked={w.length > 0} onChange={(e) => setDay(d, e.target.checked ? [{ start: "09:00", end: "17:00" }] : [])} />
                  {label}
                </label>
                {w.length === 0 ? (
                  <span className="muted">Unavailable</span>
                ) : (
                  <div className="week-wins">
                    {w.map((win, i) => (
                      <div key={i} className="week-win">
                        <input type="time" aria-label={`${label} start`} value={win.start} onChange={(e) => setDay(d, w.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                        <span aria-hidden="true">to</span>
                        <input type="time" aria-label={`${label} end`} value={win.end} onChange={(e) => setDay(d, w.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                        <button type="button" className="btn sm ghost icon" aria-label={`Remove this block on ${label}`} onClick={() => setDay(d, w.filter((_, j) => j !== i))}>
                          <Icon name="x" />
                        </button>
                      </div>
                    ))}
                    {w.length < 6 ? (
                      <button type="button" className="btn sm ghost" onClick={() => setDay(d, [...w, { start: "13:00", end: "17:00" }])}>
                        <Icon name="plus" /> Add hours
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="span-2 week-edit">
          <legend>Special dates</legend>
          <p className="muted">Close a day, or open one with different hours: a holiday, a vacation, or a mini-session day. These replace the weekly hours for that date.</p>
          {overrides.map(([date, w]) => (
            <div key={date} className="week-row override-row">
              <input type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && setOverride(e.target.value, w, date)} />
              <label className="week-day">
                <input type="checkbox" checked={w.length === 0} onChange={(e) => setOverride(date, e.target.checked ? [] : [{ start: "10:00", end: "14:00" }])} />
                Closed
              </label>
              {w.length > 0 ? (
                <div className="week-win">
                  <input type="time" aria-label={`${date} start`} value={w[0]!.start} onChange={(e) => setOverride(date, [{ ...w[0]!, start: e.target.value }])} />
                  <span aria-hidden="true">to</span>
                  <input type="time" aria-label={`${date} end`} value={w[0]!.end} onChange={(e) => setOverride(date, [{ ...w[0]!, end: e.target.value }])} />
                </div>
              ) : null}
              <button type="button" className="btn sm ghost icon" aria-label={`Remove ${date}`} onClick={() => setOverride(date, null, date)}>
                <Icon name="x" />
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn sm ghost" onClick={() => {
              let d = new Date();
              let key = d.toISOString().slice(0, 10);
              while (f.dateOverrides?.[key]) { d = new Date(d.getTime() + 86_400_000); key = d.toISOString().slice(0, 10); }
              setOverride(key, []);
            }}>
              <Icon name="plus" /> Add a date
            </button>
          </div>
        </fieldset>

        <Field label="Most bookings per day" hint="Leave 0 for no limit.">{(p) => <TextInput {...p} inputMode="numeric" value={f.maxPerDay} onChange={num("maxPerDay")} />}</Field>
        <Field label="Buffer before (min)">{(p) => <TextInput {...p} inputMode="numeric" value={f.bufferBeforeMinutes} onChange={num("bufferBeforeMinutes")} />}</Field>
        <Field label="Buffer after (min)">{(p) => <TextInput {...p} inputMode="numeric" value={f.bufferAfterMinutes} onChange={num("bufferAfterMinutes")} />}</Field>
        <Field label="Minimum notice (hours)" hint="How soon before a time it can still be booked.">{(p) => <TextInput {...p} inputMode="numeric" value={f.minNoticeHours} onChange={num("minNoticeHours")} />}</Field>
        <Field label="Book up to (days ahead)">{(p) => <TextInput {...p} inputMode="numeric" value={f.maxDaysAhead} onChange={num("maxDaysAhead")} />}</Field>
        <Field label="Start times every (min)">
          {(p) => (
            <select {...p} className="input" value={f.stepMinutes} onChange={num("stepMinutes")}>
              {[15, 20, 30, 45, 60].map((n) => <option key={n} value={n}>{n} minutes</option>)}
            </select>
          )}
        </Field>
        <Field label="Shoot type" hint="Used when a booking becomes a lead.">
          {(p) => (
            <select {...p} className="input" value={f.shootTypeId ?? ""} onChange={(e) => setF((x) => ({ ...x, shootTypeId: e.target.value || null }))}>
              <option value="">None</option>
              {(types.data?.types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </Field>
        {f.shootTypeId ? (
          <div className="span-2">
            <SwitchRow checked={f.createShoot} onChange={(v) => setF((x) => ({ ...x, createShoot: v }))} label="Make a shoot when it's booked" hint="A confirmed booking becomes a shoot with this time on it, ready for questionnaires, contracts and a gallery. Leave it off for calls and consults that stay as leads." />
          </div>
        ) : null}
        <fieldset className="span-2 pay-edit">
          <legend>Price and retainer</legend>
          <Field label="Price" hint="Leave empty if the page is free to book.">
            {(p) => <TextInput {...p} inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} />}
          </Field>
          {parseMoney(price || "0") ? (
            <>
              <div className="seg" role="radiogroup" aria-label="Retainer">
                {([["none", "No retainer"], ["percent", "Percent"], ["fixed", "Fixed amount"]] as const).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={f.depositType === k} className={f.depositType === k ? "on" : ""} onClick={() => setF((x) => ({ ...x, depositType: k }))}>
                    {label}
                  </button>
                ))}
              </div>
              {f.depositType !== "none" ? (
                <Field label={f.depositType === "percent" ? "Retainer (% of the total)" : "Retainer amount"} hint="Clients pay it right after booking. The balance is due on the day.">
                  {(p) => <TextInput {...p} inputMode="decimal" placeholder={f.depositType === "percent" ? "25" : "50.00"} value={deposit} onChange={(e) => setDeposit(e.target.value)} />}
                </Field>
              ) : null}
            </>
          ) : null}
          {parseMoney(price || "0") && (templates.data?.items.length ?? 0) > 0 ? (
            <Field label="Agreement to sign first" hint="Sent with the booking email. Clients can't pay online until they've signed. Use only client, studio, order and date fields.">
              {(p) => (
                <select {...p} className="input" value={f.contractTemplateId ?? ""} onChange={(e) => setF((x) => ({ ...x, contractTemplateId: e.target.value || null }))}>
                  <option value="">None</option>
                  {(templates.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </Field>
          ) : null}
        </fieldset>
        <div className="span-2">
          <SwitchRow checked={f.approval === "auto"} onChange={(v) => setF((x) => ({ ...x, approval: v ? "auto" : "manual" }))} label="Book instantly" hint="Clients get a confirmed time right away. Otherwise you approve each request." />
        </div>
        <Field className="span-2" label="Link address" hint="The last part of the link. Leave blank to use the name." error={fieldErrors.slug}>
          {(p) => <TextInput {...p} value={f.slug} onChange={txt("slug")} placeholder="30-minute-consult" autoComplete="off" spellCheck={false} />}
        </Field>
      </form>
    </Dialog>
  );
}
