import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Callout, CopyValue, EmptyState, Field, Icon, Panel, StatusChip, Switch, TextInput, useToast, type IconName } from "@openportrait/ui";
import { api, type AiActivityItem, type AiConnection, type AiLevel, type AiStatus } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";

const LEVELS: Array<{ id: AiLevel; title: string; text: string }> = [
  { id: "read", title: "Look only", text: "Can read and search. Can't change anything." },
  { id: "assist", title: "Assist", text: "Can also add notes, tasks and drafts. Anything that reaches a client waits for your OK." },
  { id: "full", title: "Full", text: "Same as Assist for now. Sending and payments will always ask you first." },
];

const AREA_LABELS: Record<string, string> = {
  studio: "Studio info",
  contacts: "Contacts",
  leads: "Leads",
  shoots: "Shoots",
  calendar: "Calendar",
  quotes: "Quotes",
  orders: "Orders",
  galleries: "Galleries",
  email: "Email",
};
/** Areas that have tools today. The rest light up as those parts of OpenPortrait are built. */
const LIVE_AREAS = new Set(["studio"]);

const ago = (ms: number | null) => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

type Snippet = "claude-code" | "cursor" | "other";

function snippetFor(kind: Snippet, url: string, token: string) {
  if (kind === "claude-code") return `claude mcp add --transport http openportrait ${url} --header "Authorization: Bearer ${token}"`;
  if (kind === "cursor") return JSON.stringify({ mcpServers: { openportrait: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  return `URL: ${url}\nHeader: Authorization: Bearer ${token}`;
}

function NewToken({ token, url, onDone }: { token: string; url: string; onDone: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Snippet>("claude-code");
  const tabs: Array<[Snippet, string]> = [["claude-code", "Claude Code"], ["cursor", "Cursor"], ["other", "Other"]];
  return (
    <Callout tone="ok" title="Copy this now. It won't be shown again.">
      <div className="ai-token">
        <CopyValue value={token} label="access token" />
        <div role="tablist" aria-label="Where to use it" className="tabs">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <pre className="snippet" tabIndex={0}>{snippetFor(tab, url, token)}</pre>
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <Button size="sm" icon="copy" onClick={() => void navigator.clipboard?.writeText(snippetFor(tab, url, token)).then(() => toast("Copied"))}>
            Copy setup
          </Button>
          <Button size="sm" variant="primary" onClick={onDone}>I've saved it</Button>
        </div>
      </div>
    </Callout>
  );
}

function Hero({ s, onToggle, onPause, busy }: { s: AiStatus; onToggle: (v: boolean) => void; onPause: () => void; busy: boolean }) {
  let orb: { tone: string; icon: IconName } = { tone: "", icon: "sparkle" };
  let headline = "AI access is off";
  let sub = "Turn it on to let an AI assistant like Claude work with your studio.";
  let chip: { tone: "neutral" | "ok" | "warn" | "info"; label: string; pulse?: boolean } = { tone: "neutral", label: "Off" };
  if (s.enabled && s.paused) {
    orb = { tone: "warn", icon: "alert" };
    headline = "Paused";
    sub = "Every connected assistant is blocked until you resume.";
    chip = { tone: "warn", label: "Paused" };
  } else if (s.enabled && s.lastSeenAt) {
    orb = { tone: "ok", icon: "check" };
    headline = "An assistant is connected";
    sub = `Last activity ${ago(s.lastSeenAt)}.`;
    chip = { tone: "ok", label: "Connected" };
  } else if (s.enabled) {
    headline = "Ready for an assistant";
    sub = "Create a connection below, then add it to your assistant. This turns green when it connects.";
    chip = { tone: "info", label: "Waiting", pulse: true };
  }
  return (
    <section className="panel">
      <div className="panel-body">
        <div className="net-status">
          <div className="big">
            <span className={`orb ${orb.tone}`}>
              <Icon name={orb.icon} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h2>{headline}</h2>
              <p className="sub">{sub}</p>
            </div>
          </div>
          <div className="form-actions">
            <StatusChip tone={chip.tone} pulse={chip.pulse}>{chip.label}</StatusChip>
            {s.enabled ? (
              <Button size="sm" icon={s.paused ? "refresh" : "x"} onClick={onPause} loading={busy}>
                {s.paused ? "Resume" : "Pause all AI access"}
              </Button>
            ) : null}
            <Switch checked={s.enabled} onChange={onToggle} label="Enable AI access" disabled={busy} />
          </div>
        </div>
      </div>
    </section>
  );
}

export function ConnectAISettingsPage() {
  const toast = useToast();
  const [s, setS] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<AiActivityItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [level, setLevel] = useState<AiLevel>("read");
  const [areas, setAreas] = useState<string[]>(["studio"]);
  const [expires, setExpires] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, act] = await Promise.all([api<AiStatus>("/ai"), api<{ items: AiActivityItem[] }>("/ai/activity")]);
      setS(st);
      setActivity(act.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load AI settings.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const update = async (body: { enabled?: boolean; paused?: boolean }, message: string) => {
    setBusy(true);
    try {
      setS(await api<AiStatus>("/ai", { method: "PUT", body }));
      toast(message);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't save.", "bad");
    } finally {
      setBusy(false);
    }
  };

  const create = useSubmit(async () => {
    const res = await api<{ token: string; status: AiStatus }>("/ai/connections", {
      method: "POST",
      body: { label, level, areas, expiresInDays: expires ? Number(expires) : null },
    });
    setS(res.status);
    setFresh(res.token);
    setLabel("");
    return res;
  });

  const revoke = async (c: AiConnection) => {
    if (!window.confirm(`Disconnect “${c.label}”? It will stop working immediately.`)) return;
    try {
      setS(await api<AiStatus>(`/ai/connections/${c.id}`, { method: "DELETE" }));
      toast("Connection removed");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove it.", "bad");
    }
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    await create.submit();
  };

  if (error && !s) return <Callout tone="bad" title="Couldn't load AI settings">{error}</Callout>;
  if (!s) return <div className="boot" aria-busy="true" aria-label="Loading" />;

  const url = s.urls.public ?? s.urls.lan ?? "";
  return (
    <>
      <Hero s={s} onToggle={(v) => update({ enabled: v }, v ? "AI access is on" : "AI access is off")} onPause={() => update({ paused: !s.paused }, s.paused ? "AI access resumed" : "AI access paused")} busy={busy} />

      {s.enabled ? (
        <>
          <Panel title="1 · Your address" description="Assistants connect to this address. It's separate from the studio pages, so Cloudflare Access doesn't block it.">
            {url ? <CopyValue value={url} label="MCP address" /> : null}
            {!s.urls.public ? (
              <Callout tone="warn" title="No public address yet" action={<Link className="btn sm" to="../internet">Set up internet access</Link>}>
                Assistants in the cloud can't reach you until your studio is online. The local address above works for apps on your own network.
              </Callout>
            ) : !s.online ? (
              <Callout tone="warn" title="Your tunnel isn't connected right now" action={<Link className="btn sm" to="../internet">Check tunnel</Link>}>
                Remote assistants can't connect until it is.
              </Callout>
            ) : null}
          </Panel>

          <Panel title="2 · Create a connection" description="Each assistant or app gets its own connection, so you can see what it did and cut it off on its own.">
            {fresh ? (
              <NewToken token={fresh} url={url} onDone={() => setFresh(null)} />
            ) : (
              <form onSubmit={onCreate} noValidate className="ai-form">
                <Field label="Name" error={create.fieldErrors.label ?? create.error} hint="Something you'll recognise, like “Claude Code on my laptop”.">
                  {(p) => <TextInput {...p} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />}
                </Field>
                <fieldset className="choice-set">
                  <legend>What can it do?</legend>
                  <div className="choice-grid">
                    {LEVELS.map((l) => (
                      <label key={l.id} className={`choice ${level === l.id ? "on" : ""}`}>
                        <input type="radio" name="level" checked={level === l.id} onChange={() => setLevel(l.id)} />
                        <b>{l.title}</b>
                        <span>{l.text}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="choice-set">
                  <legend>Which parts of the studio?</legend>
                  <div className="area-grid">
                    {s.areas.map((a) => {
                      const live = LIVE_AREAS.has(a);
                      return (
                        <label key={a} className={`area ${live ? "" : "soon"}`}>
                          <input type="checkbox" checked={areas.includes(a)} onChange={(e) => setAreas(e.target.checked ? [...areas, a] : areas.filter((x) => x !== a))} />
                          <span>{AREA_LABELS[a] ?? a}</span>
                          {live ? null : <small>Soon</small>}
                        </label>
                      );
                    })}
                  </div>
                  {create.fieldErrors.areas ? <span className="error-text"><Icon name="alert" width={16} height={16} />{create.fieldErrors.areas}</span> : null}
                </fieldset>
                <Field label="Expires">
                  {(p) => (
                    <select {...p} className="input" value={expires} onChange={(e) => setExpires(e.target.value)}>
                      <option value="">Never</option>
                      <option value="30">In 30 days</option>
                      <option value="90">In 90 days</option>
                      <option value="365">In a year</option>
                    </select>
                  )}
                </Field>
                <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                  <Button type="submit" variant="primary" icon="key" loading={create.busy} disabled={!label.trim()}>
                    Create connection
                  </Button>
                </div>
              </form>
            )}
            <p className="hint">Claude and ChatGPT's “add a connector” screens use one-click sign-in, which is coming next. Until then, use a token with Claude Code, Cursor or any MCP app.</p>
          </Panel>

          <Panel title="Connections">
            {s.connections.length === 0 ? (
              <EmptyState icon="sparkle" title="Nothing connected yet">Connections you create show up here with when they were last used.</EmptyState>
            ) : (
              <ul className="conn-list">
                {s.connections.map((c) => (
                  <li key={c.id}>
                    <div>
                      <b>{c.label}</b>
                      <span>
                        {LEVELS.find((l) => l.id === c.level)?.title} · {c.areas.map((a) => AREA_LABELS[a] ?? a).join(", ")} · …{c.tokenHint}
                      </span>
                      <span>
                        Last used {ago(c.lastUsedAt)}
                        {c.expiresAt ? (c.expired ? " · Expired" : ` · Expires ${new Date(c.expiresAt).toLocaleDateString()}`) : ""}
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" className="danger" onClick={() => revoke(c)} aria-label={`Disconnect ${c.label}`}>
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Recent activity" description="Everything an assistant does is logged here.">
            {activity.length === 0 ? (
              <p className="hint">No activity yet.</p>
            ) : (
              <ul className="activity">
                {activity.map((a) => (
                  <li key={a.id}>
                    <Icon name={a.ok ? "check" : "alert"} width={16} height={16} />
                    <span><b>{a.connection}</b> ran <code>{a.action}</code></span>
                    <time>{ago(a.at)}</time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}
    </>
  );
}
