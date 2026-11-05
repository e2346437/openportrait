import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { BrandImagePanel } from "../../components/BrandImagePanel.js";
import { useSession } from "../../lib/session.js";
import { allTimezones, prettyTimezone } from "../../lib/timezones.js";
import { useSubmit } from "../../lib/useForm.js";

interface Address {
  street: string;
  unit: string;
  city: string;
  state: string;
  postal: string;
}
interface DayHours {
  open: boolean;
  from: string;
  to: string;
}
interface Studio {
  name: string;
  email: string;
  timezone: string;
  phone: string;
  website: string;
  physicalAddress: Address;
  /** Null means the same as the physical address. */
  mailingAddress: Address | null;
  showAddress: boolean;
  /** Null means hours are not shown. */
  hours: { days: DayHours[]; note: string } | null;
}

const NO_ADDRESS: Address = { street: "", unit: "", city: "", state: "", postal: "" };
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DEFAULT_HOURS = { days: DAYS.map((_, i) => ({ open: i < 5, from: "09:00", to: "17:00" })), note: "" };
const BLANK: Studio = { name: "", email: "", timezone: "UTC", phone: "", website: "", physicalAddress: NO_ADDRESS, mailingAddress: null, showAddress: false, hours: null };

function AddressFields({ value, onChange, disabled, label }: { value: Address; onChange: (a: Address) => void; disabled: boolean; label: string }) {
  const set = (k: keyof Address) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="form-grid tight">
      <Field className="span-2" label="Street">{(p) => <TextInput {...p} value={value.street} disabled={disabled} onChange={set("street")} autoComplete={`${label} address-line1`} maxLength={160} />}</Field>
      <Field className="span-2" label="Suite or unit">{(p) => <TextInput {...p} value={value.unit} disabled={disabled} onChange={set("unit")} autoComplete={`${label} address-line2`} maxLength={60} />}</Field>
      <div className="span-2 addr-row">
        <Field label="City">{(p) => <TextInput {...p} value={value.city} disabled={disabled} onChange={set("city")} autoComplete={`${label} address-level2`} maxLength={80} />}</Field>
        <Field label="State">{(p) => <TextInput {...p} value={value.state} disabled={disabled} onChange={set("state")} autoComplete={`${label} address-level1`} maxLength={60} />}</Field>
        <Field label="ZIP">{(p) => <TextInput {...p} value={value.postal} disabled={disabled} onChange={set("postal")} autoComplete={`${label} postal-code`} maxLength={20} />}</Field>
      </div>
    </div>
  );
}

export function StudioSettingsPage() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const owner = me?.user?.role === "owner";
  const [saved, setSaved] = useState<Studio | null>(null);
  const [form, setForm] = useState<Studio>(BLANK);
  const [loadError, setLoadError] = useState<string | null>(null);
  const zones = useMemo(() => allTimezones(form.timezone), [form.timezone]);

  useEffect(() => {
    api<Studio>("/settings/studio")
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const dirty = saved !== null && JSON.stringify(form) !== JSON.stringify(saved);
  const setHours = (i: number, patch: Partial<DayHours>) => form.hours && setForm({ ...form, hours: { ...form.hours, days: form.hours.days.map((d, k) => (k === i ? { ...d, ...patch } : d)) } });
  const { busy, error, fieldErrors, submit } = useSubmit(() => api<Studio>("/settings/studio", { method: "PUT", body: form }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await submit();
    if (!result) return;
    setSaved(result);
    setForm(result);
    await refresh();
    toast("Studio details saved");
  };

  if (loadError) return <Callout tone="bad" title="Couldn't load studio settings">{loadError}</Callout>;

  const footer = owner ? (
    <div className="form-actions">
      {dirty ? (
        <Button variant="ghost" onClick={() => saved && setForm(saved)}>
          Discard changes
        </Button>
      ) : null}
      <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
        Save changes
      </Button>
    </div>
  ) : (
    <span className="hint">Only the studio owner can change these.</span>
  );
  const ro = !owner;

  return (
    <form onSubmit={onSubmit} noValidate className="stack">
      <Panel title="Studio details" description="Clients see these on booking pages, galleries, contracts, invoices, and emails.">
        {error ? <Callout tone="bad">{error}</Callout> : null}
        {saved === null ? (
          <div className="form-grid" aria-busy="true">
            <div className="skeleton" style={{ height: 66 }} />
            <div className="skeleton" style={{ height: 66 }} />
            <div className="skeleton" style={{ height: 66 }} />
            <div className="skeleton" style={{ height: 66 }} />
          </div>
        ) : (
          <div className="form-grid">
            <Field label="Studio name" error={fieldErrors.name}>
              {(p) => <TextInput {...p} value={form.name} disabled={ro} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />}
            </Field>
            <Field label="Studio email" error={fieldErrors.email} hint="Replies from clients go here.">
              {(p) => <TextInput {...p} type="email" value={form.email} disabled={ro} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
            </Field>
            <Field label="Contact phone" error={fieldErrors.phone} hint="Shown on invoices and contracts.">
              {(p) => <TextInput {...p} type="tel" inputMode="tel" autoComplete="tel" value={form.phone} disabled={ro} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={40} />}
            </Field>
            <Field label="Website" error={fieldErrors.website}>
              {(p) => <TextInput {...p} type="url" inputMode="url" value={form.website} disabled={ro} placeholder="https://" onChange={(e) => setForm({ ...form, website: e.target.value })} maxLength={200} />}
            </Field>
            <Field className="span-2" label="Time zone" error={fieldErrors.timezone} hint="Booking times and reminders use this time zone.">
              {(p) => (
                <select {...p} className="input" value={form.timezone} disabled={ro} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {prettyTimezone(z)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
      </Panel>

      {saved !== null ? (
        <>
          <Panel title="Addresses" description="Use the physical address for client visits and maps. Use the mailing address for invoices and legal notices.">
            <div className="form-grid">
              <fieldset className="plain-fieldset">
                <legend>Physical address</legend>
                <AddressFields value={form.physicalAddress} disabled={ro} label="section-physical" onChange={(a) => setForm({ ...form, physicalAddress: a })} />
                <SwitchRow checked={form.showAddress} onChange={(v) => !ro && setForm({ ...form, showAddress: v })} label="Show this address publicly" hint="On your booking and inquiry pages and in email footers." />
              </fieldset>
              <fieldset className="plain-fieldset">
                <legend>Mailing address</legend>
                <SwitchRow checked={form.mailingAddress === null} onChange={(same) => !ro && setForm({ ...form, mailingAddress: same ? null : { ...form.physicalAddress } })} label="Same as physical address" hint={form.mailingAddress === null ? "Invoices and contracts use the physical address." : undefined} />
                {form.mailingAddress ? <AddressFields value={form.mailingAddress} disabled={ro} label="section-mailing" onChange={(a) => setForm({ ...form, mailingAddress: a })} /> : null}
              </fieldset>
            </div>
          </Panel>

          <Panel
            title="Hours of operation"
            description="Optional. Leave off if you work by appointment. When on, hours appear on your booking page and in email footers."
            actions={<SwitchRow checked={form.hours !== null} onChange={(v) => !ro && setForm({ ...form, hours: v ? DEFAULT_HOURS : null })} label="Show hours" />}
            footer={footer}
          >
            {form.hours ? (
              <div className="hours-grid">
                {DAYS.map((d, i) => {
                  const h = form.hours!.days[i]!;
                  return (
                    <div key={d} className="hours-row">
                      <b>{d}</b>
                      <input className="input" type="time" aria-label={`${d} opens`} value={h.from} disabled={ro || !h.open} onChange={(e) => setHours(i, { from: e.target.value })} />
                      <input className="input" type="time" aria-label={`${d} closes`} value={h.to} disabled={ro || !h.open} onChange={(e) => setHours(i, { to: e.target.value })} />
                      <SwitchRow checked={h.open} onChange={(v) => !ro && setHours(i, { open: v })} label={h.open ? "Open" : "Closed"} />
                    </div>
                  );
                })}
                <Field label="Note" hint="For example, “By appointment on weekends”.">
                  {(p) => <TextInput {...p} value={form.hours!.note} disabled={ro} maxLength={200} onChange={(e) => setForm({ ...form, hours: { ...form.hours!, note: e.target.value } })} />}
                </Field>
              </div>
            ) : (
              <p className="hint">Hours are not shown to clients.</p>
            )}
          </Panel>
        </>
      ) : null}
      <BrandImagePanel
        kind="sign-in"
        owner={owner}
        title="Sign-in photo"
        description="One of your own photos, shown behind the sign-in page. It is public, like your logo, and is resized and stripped of camera data. Without one, the page shows the OpenPortrait mark."
        alt="Sign-in photo"
        wide
      />
    </form>
  );
}
