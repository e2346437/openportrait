import { AddOnPrompt } from "../../components/AddOnPrompt.js";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, EmptyState, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { relative } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";

interface EmailState {
  configured: boolean;
  /** Set when an extension's mailbox is sending the studio's email. */
  outside?: string | null;
  host: string;
  port: number;
  security: "none" | "starttls" | "tls";
  user: string;
  hasPassword: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  recent: Array<{ id: string; toAddress: string; subject: string; kind: string; status: string; error: string | null; createdAt: string | number; sentAt: string | number | null }>;
}

const PRESETS: Array<{ label: string; host: string; port: number; security: "starttls" | "tls" }> = [
  { label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 587, security: "starttls" },
  { label: "Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls" },
  { label: "Fastmail", host: "smtp.fastmail.com", port: 465, security: "tls" },
];

/** Where outgoing email (inquiry replies, booking confirmations) is sent from. */
export function EmailSettingsPage() {
  const toast = useToast();
  const { data, error, reload } = useLoad<EmailState>("/email");
  const [f, setF] = useState({ host: "", port: "587", security: "starttls", user: "", password: "", fromName: "", fromAddress: "", replyTo: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    if (data) setF({ host: data.host, port: String(data.port), security: data.security, user: data.user, password: "", fromName: data.fromName, fromAddress: data.fromAddress, replyTo: data.replyTo });
  }, [data?.host, data?.port, data?.security, data?.user, data?.fromName, data?.fromAddress, data?.replyTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useSubmit(() => api("/email", { method: "PUT", body: { ...f, port: Number(f.port), ...(f.password ? { password: f.password } : {}) } }));
  const test = useSubmit(() => api<{ to: string }>("/email/test", { method: "POST" }));

  if (error && !data) return <Callout tone="bad" title="Couldn't load email settings">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.submit()) === undefined) return;
    toast("Saved");
    reload();
  };
  const onTest = async () => {
    const r = await test.submit();
    if (r) toast(`Test email sent to ${r.to}`);
    reload();
  };

  return (
    <div className="stack">
      <Panel
        title="Outgoing email"
        description="OpenPortrait sends booking confirmations and inquiry replies through your own email account, so they come from you."
        actions={<StatusChip tone={data.configured ? "ok" : "warn"}>{data.configured ? "Ready" : "Not set up"}</StatusChip>}
      >
        {data.outside ? (
          <Callout tone="info">Email is going out through {data.outside}, so the server settings below aren't used while it is connected. Disconnect it in Settings &gt; Extensions to go back to them.</Callout>
        ) : null}
        <form onSubmit={onSave} noValidate className="form-grid">
          {save.error ? (
            <div className="span-2">
              <Callout tone="bad">{save.error}</Callout>
            </div>
          ) : null}
          <div className="span-2 presets" role="group" aria-label="Fill in common providers">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn sm" onClick={() => setF((x) => ({ ...x, host: p.host, port: String(p.port), security: p.security }))}>
                {p.label}
              </button>
            ))}
          </div>
          <Field label="Server" hint="For example smtp.example.com." error={save.fieldErrors.host}>
            {(p) => <TextInput {...p} value={f.host} onChange={set("host")} autoComplete="off" spellCheck={false} />}
          </Field>
          <div className="form-grid tight">
            <Field label="Port">{(p) => <TextInput {...p} inputMode="numeric" value={f.port} onChange={set("port")} />}</Field>
            <Field label="Security">
              {(p) => (
                <select {...p} className="input" value={f.security} onChange={set("security")}>
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="tls">SSL/TLS (465)</option>
                  <option value="none">None</option>
                </select>
              )}
            </Field>
          </div>
          <Field label="Username">{(p) => <TextInput {...p} value={f.user} onChange={set("user")} autoComplete="off" />}</Field>
          <Field label="Password" hint={data.hasPassword ? "Saved. Leave blank to keep it. Many providers need an app password." : "Many providers need an app password."}>
            {(p) => <TextInput {...p} type="password" value={f.password} onChange={set("password")} autoComplete="new-password" placeholder={data.hasPassword ? "••••••••" : ""} />}
          </Field>
          <Field label="From name" hint="Defaults to your studio name.">{(p) => <TextInput {...p} value={f.fromName} onChange={set("fromName")} />}</Field>
          <Field label="From address" error={save.fieldErrors.fromAddress}>{(p) => <TextInput {...p} type="email" value={f.fromAddress} onChange={set("fromAddress")} />}</Field>
          <Field className="span-2" label="Reply-to" hint="Optional. Where client replies should go.">{(p) => <TextInput {...p} type="email" value={f.replyTo} onChange={set("replyTo")} />}</Field>
          <div className="span-2 form-actions">
            <Button variant="primary" type="submit" loading={save.busy}>
              Save
            </Button>
            <Button type="button" icon="mail" disabled={!data.configured} loading={test.busy} onClick={onTest}>
              Send a test email
            </Button>
          </div>
          {test.error ? (
            <div className="span-2">
              <Callout tone="bad" title="The test email didn't go through">
                {test.error}
              </Callout>
            </div>
          ) : null}
        </form>
      </Panel>

      <Panel title="Recent emails" description="The last 20 messages OpenPortrait sent." flush>
        {data.recent.length === 0 ? (
          <EmptyState icon="mail" title="Nothing sent yet">Booking confirmations and inquiry replies will show up here.</EmptyState>
        ) : (
          <ul className="activity mail-log">
            {data.recent.map((m) => (
              <li key={m.id}>
                <StatusChip tone={m.status === "sent" ? "ok" : m.status === "failed" ? "bad" : "neutral"}>{m.status}</StatusChip>
                <span className="mail-what">
                  <b>{m.subject}</b>
                  <small>
                    {m.toAddress}
                    {m.error ? ` · ${m.error}` : ""}
                  </small>
                </span>
                <time>{relative(new Date(m.createdAt).getTime())}</time>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <AddOnPrompt feature="microsoft365" />
    </div>
  );
}
