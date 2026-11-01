import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { allTimezones, prettyTimezone } from "../../lib/timezones.js";
import { useSubmit } from "../../lib/useForm.js";

interface Studio {
  name: string;
  email: string;
  timezone: string;
}

export function StudioSettingsPage() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const owner = me?.user?.role === "owner";
  const [saved, setSaved] = useState<Studio | null>(null);
  const [form, setForm] = useState<Studio>({ name: "", email: "", timezone: "UTC" });
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

  const dirty = saved !== null && (form.name !== saved.name || form.email !== saved.email || form.timezone !== saved.timezone);
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

  return (
    <form onSubmit={onSubmit} noValidate>
      <Panel
        title="Studio details"
        description="Clients see these on booking pages, galleries, and emails."
        footer={
          owner ? (
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
          )
        }
      >
        {error ? <Callout tone="bad">{error}</Callout> : null}
        {saved === null ? (
          <div className="form-grid" aria-busy="true">
            <div className="skeleton" style={{ height: 66 }} />
            <div className="skeleton" style={{ height: 66 }} />
            <div className="skeleton span-2" style={{ height: 66 }} />
          </div>
        ) : (
          <div className="form-grid">
            <Field label="Studio name" error={fieldErrors.name}>
              {(p) => <TextInput {...p} value={form.name} disabled={!owner} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />}
            </Field>
            <Field label="Studio email" error={fieldErrors.email} hint="Replies from clients go here.">
              {(p) => <TextInput {...p} type="email" value={form.email} disabled={!owner} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
            </Field>
            <Field className="span-2" label="Time zone" error={fieldErrors.timezone} hint="Booking times and reminders use this time zone.">
              {(p) => (
                <select {...p} className="input" value={form.timezone} disabled={!owner} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
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
    </form>
  );
}
