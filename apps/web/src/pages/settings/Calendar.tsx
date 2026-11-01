import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Button, Callout, CopyValue, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { relative } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { ExternalLink, Step } from "./Internet.js";

interface GoogleState {
  configured: boolean;
  connected: boolean;
  email: string | null;
  needsReconnect: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  clientId: string;
  hasSecret: boolean;
  redirectUri: string;
  hasPublicUrl: boolean;
}
interface Choice {
  id: string;
  name: string;
  primary: boolean;
  busy: boolean;
}

const GCP = "https://console.cloud.google.com/";

export function CalendarSettingsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data: g, error, reload } = useLoad<GoogleState>("/google");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const returned = params.get("google_error");

  useEffect(() => {
    if (params.get("google") === "connected") toast("Google Calendar connected. The first sync is running.");
    if (params.has("google") || params.has("google_error")) {
      // Keep the error visible, but drop the flags from the address.
      const p = new URLSearchParams(params);
      p.delete("google");
      setParams(p, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (g) setClientId(g.clientId);
  }, [g?.clientId]);

  const save = useSubmit(() => api("/google/client", { method: "PUT", body: { clientId, ...(secret ? { clientSecret: secret } : {}) } }));
  const connect = useSubmit(async () => {
    const { url } = await api<{ url: string }>("/google/connect", { method: "POST" });
    window.location.assign(url);
    return true;
  });

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.submit()) === undefined) return;
    setSecret("");
    setEditing(false);
    reload();
    toast("Saved");
  };

  const syncNow = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await api<{ pushed: number; pulled: number; removed: number }>("/google/sync", { method: "POST" });
      toast(r.pushed + r.pulled + r.removed ? `Synced: ${r.pushed} sent, ${r.pulled} received, ${r.removed} removed.` : "Already up to date.");
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "The sync didn't run.");
    } finally {
      setSyncing(false);
      reload();
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Google Calendar? Events already in Google stay there, but OpenPortrait stops updating them.")) return;
    await api("/google", { method: "DELETE" });
    reload();
    toast("Disconnected");
  };

  if (error && !g) return <Callout tone="bad" title="Couldn't load Google Calendar settings">{error}</Callout>;
  if (!g) return <Spinner label="Loading" />;

  const hasClient = g.configured;
  const showClientForm = !hasClient || editing;
  const done = [hasClient, hasClient, g.connected && !g.needsReconnect];
  const current = done.findIndex((d) => !d);
  const stateOf = (i: number) => (done[i] ? "done" : i === current ? "current" : "todo") as "done" | "current" | "todo";

  return (
    <>
      {g.connected ? (
        <Panel
          title="Google Calendar"
          description={g.email ? `Connected as ${g.email}.` : "Connected."}
          actions={
            <StatusChip tone={g.needsReconnect ? "warn" : g.lastError ? "bad" : "ok"}>{g.needsReconnect ? "Reconnect needed" : g.lastError ? "Last sync failed" : "Syncing"}</StatusChip>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            Shoot times, appointments and time off appear in a Google calendar named <b>OpenPortrait</b>, and edits made there come back here. {g.lastSyncAt ? `Last synced ${relative(g.lastSyncAt)}.` : "The first sync is running."}
          </p>
          {g.needsReconnect ? (
            <Callout tone="warn" title="Google needs you to sign in again" action={<Button variant="primary" loading={connect.busy} onClick={connect.submit}>Reconnect</Button>}>
              {g.lastError}
            </Callout>
          ) : g.lastError || syncError ? (
            <Callout tone="bad" title="The last sync didn't finish">
              {syncError ?? g.lastError}
            </Callout>
          ) : null}
          {connect.error ? <Callout tone="bad">{connect.error}</Callout> : null}
          <div className="form-actions">
            <Button icon="refresh" loading={syncing} onClick={syncNow}>
              Sync now
            </Button>
            <Button variant="ghost" className="danger" onClick={disconnect}>
              Disconnect
            </Button>
          </div>
        </Panel>
      ) : null}

      {g.connected && !g.needsReconnect ? <BusyCalendars onChanged={reload} /> : null}

      {returned ? <Callout tone="bad" title="Google sign-in didn't finish">{returned}</Callout> : null}

      {!g.connected ? (
        <Panel title="Connect Google Calendar" description="Use your own Google Cloud project, so your calendar data never passes through anyone else's servers. Setup takes about ten minutes, once.">
          <ol className="steps" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <Step n={1} state={stateOf(0)} title="Create credentials in Google Cloud">
              <ol>
                <li>
                  In Google Cloud, create a project (any name) and turn on the <b>Google Calendar API</b>.
                </li>
                <li>
                  Under <b>APIs &amp; Services → OAuth consent screen</b>, choose <b>External</b>, fill in the app name and your email, and add yourself as a test user. Then set the publishing status to <b>In production</b>. For your own use there's no review. Without this, Google signs you out every 7 days.
                </li>
                <li>
                  Under <b>Credentials</b>, create an <b>OAuth client ID</b> of type <b>Web application</b>. Add this as an authorized redirect URI:
                  <CopyValue value={g.redirectUri} label="redirect address" />
                </li>
              </ol>
              {!g.hasPublicUrl ? (
                <Callout tone="warn">Set up your public address under Internet access first. Google only sends you back to an address you've registered.</Callout>
              ) : null}
              <ExternalLink href={GCP}>Open Google Cloud</ExternalLink>
            </Step>
            <Step n={2} state={stateOf(1)} title="Paste the client ID and secret">
              {showClientForm ? (
                <form onSubmit={onSave} noValidate className="form-grid" style={{ marginTop: 8 }}>
                  {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
                  <Field className="span-2" label="Client ID" error={save.fieldErrors.clientId}>
                    {(p) => <TextInput {...p} autoComplete="off" spellCheck={false} value={clientId} placeholder="123456789-abc.apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />}
                  </Field>
                  <Field className="span-2" label="Client secret" hint={g.hasSecret ? "Leave blank to keep the saved secret." : undefined}>
                    {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={secret} placeholder={g.hasSecret ? "Saved" : "GOCSPX-…"} onChange={(e) => setSecret(e.target.value)} />}
                  </Field>
                  <div className="span-2 form-actions">
                    <Button variant="primary" type="submit" loading={save.busy}>
                      Save
                    </Button>
                    {editing ? <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
                  </div>
                </form>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Saved ({g.clientId.slice(0, 12)}…). <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change</Button>
                </p>
              )}
            </Step>
            <Step n={3} state={stateOf(2)} title="Sign in with Google">
              <p>OpenPortrait asks to read and change your calendars. It writes only to its own <b>OpenPortrait</b> calendar and only reads the others to know when you're busy.</p>
              {connect.error ? <Callout tone="bad">{connect.error}</Callout> : null}
              <Button variant="primary" icon="calendar" disabled={!hasClient || !g.hasPublicUrl} loading={connect.busy} onClick={connect.submit} style={{ alignSelf: "flex-start" }}>
                Connect Google Calendar
              </Button>
            </Step>
          </ol>
        </Panel>
      ) : null}
      <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
        Stuck? The <a href="https://github.com/e2346437/openportrait/blob/main/docs/google-calendar.md" target="_blank" rel="noreferrer noopener">setup guide</a> lists the common errors and their fixes.
      </p>
    </>
  );
}

function BusyCalendars({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ calendars: Choice[] }>("/google/calendars");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (data) setPicked(new Set(data.calendars.filter((c) => c.busy).map((c) => c.id)));
  }, [data]);

  const save = useSubmit(async () => {
    const calendars = (data?.calendars ?? []).filter((c) => picked?.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
    await api("/google/calendars", { method: "PUT", body: { calendars } });
    await api("/google/sync", { method: "POST" }).catch(() => undefined);
    return true;
  });

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const changed = data && picked && data.calendars.some((c) => c.busy !== picked.has(c.id));

  return (
    <Panel title="Calendars to treat as busy" description="Times on these calendars show as busy on your calendar and are kept off your booking pages. Only the time is copied, never the title.">
      {loading && !data ? <Spinner label="Loading calendars" /> : error ? <Callout tone="bad">{error}</Callout> : data && data.calendars.length === 0 ? <p className="muted" style={{ margin: 0 }}>You have no other calendars.</p> : (
        <ul className="checklist">
          {data?.calendars.map((c) => (
            <li key={c.id}>
              <label>
                <input type="checkbox" checked={picked?.has(c.id) ?? false} onChange={() => toggle(c.id)} />
                <span>
                  {c.name} {c.primary ? <small className="muted">(your main calendar)</small> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {save.error ? <Callout tone="bad">{save.error}</Callout> : null}
      <div className="form-actions">
        <Button variant="primary" disabled={!changed} loading={save.busy} onClick={async () => { if (await save.submit()) { toast("Saved"); reload(); onChanged(); } }}>
          Save
        </Button>
      </div>
    </Panel>
  );
}
