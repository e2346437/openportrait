import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, Switch, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";

type Security = "starttls" | "tls" | "none";
interface EmailSettings {
  host: string;
  port: number | null;
  security: Security;
  user: string;
  hasPassword: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  configured: boolean;
  galleryReady: { subject: string; body: string };
  defaults: { galleryReady: { subject: string; body: string } };
  mergeFields: string[];
  notifyOnSubmit: boolean;
}

const SECURITY: Array<{ id: Security; label: string; hint: string }> = [
  { id: "starttls", label: "STARTTLS", hint: "Most providers, usually port 587" },
  { id: "tls", label: "SSL/TLS", hint: "Usually port 465" },
  { id: "none", label: "None", hint: "Only for a server on your own network" },
];

export function EmailSettingsPage() {
  const { me } = useSession();
  const toast = useToast();
  const owner = me?.user?.role === "owner";
  const [saved, setSaved] = useState<EmailSettings | null>(null);
  const [form, setForm] = useState<EmailSettings | null>(null);
  const [password, setPassword] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<EmailSettings>("/email/settings")
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const dirty = !!saved && !!form && (JSON.stringify({ ...form, hasPassword: 0, configured: 0 }) !== JSON.stringify({ ...saved, hasPassword: 0, configured: 0 }) || password !== "");
  const { busy, error, fieldErrors, submit } = useSubmit(() => api<EmailSettings>("/email/settings", { method: "PUT", body: { ...form, password, galleryReady: form!.galleryReady } }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit();
    if (!r) return;
    setSaved(r);
    setForm(r);
    setPassword("");
    setTestResult(null);
    toast("Email settings saved");
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; to?: string; error?: string }>("/email/test", { method: "POST", body: {} });
      setTestResult(r.ok ? { ok: true, text: `Sent to ${r.to}. Check your inbox (and spam) in a minute.` } : { ok: false, text: r.error ?? "It couldn't be sent." });
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  if (loadError) return <Callout tone="bad" title="Couldn't load email settings">{loadError}</Callout>;
  if (!form) return <div className="skeleton" style={{ height: 320 }} aria-busy="true" />;
  const set = <K extends keyof EmailSettings>(k: K, v: EmailSettings[K]) => setForm({ ...form, [k]: v });
  const t = form.galleryReady;

  return (
    <form onSubmit={onSubmit} noValidate className="stack">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {!form.configured ? (
        <Callout tone="info" title="Email isn't set up yet">
          Add the SMTP details from your email provider so OpenPortrait can send gallery links and tell you when a client sends favorites. Until then, you can copy gallery links and send them yourself.
        </Callout>
      ) : null}

      <Panel title="Mail server" description="OpenPortrait sends through your own email account, so messages come from you and land in your Sent folder history on the provider's side.">
        <fieldset className="stack-sm" disabled={!owner}>
          <div className="form-grid">
            <Field label="SMTP server" error={fieldErrors.host} hint="For example smtp.gmail.com or smtp.office365.com">
              {(p) => <TextInput {...p} className="input mono" value={form.host} placeholder="smtp.example.com" onChange={(e) => set("host", e.target.value)} />}
            </Field>
            <Field label="Port" error={fieldErrors.port}>
              {(p) => <TextInput {...p} className="input" inputMode="numeric" value={form.port ?? ""} placeholder={form.security === "tls" ? "465" : "587"} onChange={(e) => set("port", e.target.value ? Number(e.target.value.replace(/\D/g, "")) || null : null)} />}
            </Field>
          </div>
          <fieldset className="opts">
            <legend className="label">Security</legend>
            {SECURITY.map((s) => (
              <label key={s.id} className="opt">
                <input type="radio" name="security" checked={form.security === s.id} onChange={() => set("security", s.id)} />
                <span className="t">
                  <b>{s.label}</b>
                  <span>{s.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="form-grid">
            <Field label="Username" error={fieldErrors.user} hint="Often your full email address. Leave empty if the server needs none.">
              {(p) => <TextInput {...p} autoComplete="off" value={form.user} onChange={(e) => set("user", e.target.value)} />}
            </Field>
            <Field label="Password" error={fieldErrors.password} hint={form.hasPassword ? "A password is saved. Type here only to replace it." : "Many providers need an app password, not your normal one."}>
              {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={password} placeholder={form.hasPassword ? "••••••••" : ""} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          </div>
        </fieldset>
      </Panel>

      <Panel title="Sender" description="How the email appears to clients.">
        <fieldset className="stack-sm" disabled={!owner}>
          <div className="form-grid">
            <Field label="From name" error={fieldErrors.fromName} hint="Your studio name is used if empty.">
              {(p) => <TextInput {...p} value={form.fromName} onChange={(e) => set("fromName", e.target.value)} />}
            </Field>
            <Field label="From address" error={fieldErrors.fromAddress} hint="Must be an address your provider lets you send from.">
              {(p) => <TextInput {...p} type="email" value={form.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} />}
            </Field>
          </div>
          <Field label="Replies go to" error={fieldErrors.replyTo} hint="Optional. Leave empty to reply to the From address.">
            {(p) => <TextInput {...p} type="email" value={form.replyTo} onChange={(e) => set("replyTo", e.target.value)} />}
          </Field>
        </fieldset>
      </Panel>

      <Panel title="Gallery ready email" description="Sent when you email a client their gallery link. Use merge fields to fill in names and links.">
        <fieldset className="stack-sm" disabled={!owner}>
          <Field label="Subject" error={fieldErrors["galleryReady.subject"]}>
            {(p) => <TextInput {...p} value={t.subject} onChange={(e) => set("galleryReady", { ...t, subject: e.target.value })} />}
          </Field>
          <Field label="Message" error={fieldErrors["galleryReady.body"]} hint={`Merge fields: ${form.mergeFields.map((f) => `{{${f}}}`).join(", ")}. The button with the link is added for you.`}>
            {(p) => <TextArea {...p} rows={8} value={t.body} onChange={(e) => set("galleryReady", { ...t, body: e.target.value })} />}
          </Field>
          <div>
            <Button size="sm" variant="ghost" type="button" onClick={() => set("galleryReady", form.defaults.galleryReady)}>
              Reset to the standard wording
            </Button>
          </div>
        </fieldset>
        <div className="toggle-row">
          <div>
            <b>Email me when a client sends favorites</b>
            <span>Goes to your studio email address.</span>
          </div>
          <Switch label="Email me when a client sends favorites" checked={form.notifyOnSubmit} disabled={!owner} onChange={(v) => set("notifyOnSubmit", v)} />
        </div>
      </Panel>

      <div className="form-actions between">
        <div className="test-row">
          <Button type="button" icon="send" loading={testing} disabled={dirty || !form.configured} onClick={sendTest}>
            Send me a test email
          </Button>
          {dirty ? <span className="hint">Save your changes first.</span> : null}
          {testResult ? (
            <span className={`test-result ${testResult.ok ? "ok" : "bad"}`} role="status">
              {testResult.text}
            </span>
          ) : null}
        </div>
        {owner ? (
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            Save changes
          </Button>
        ) : (
          <span className="hint">Only the studio owner can change these.</span>
        )}
      </div>
    </form>
  );
}
