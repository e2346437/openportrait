import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Callout, CopyValue, Field, Icon, Panel, Spinner, StatusChip, Switch, TextArea, TextInput, useToast, type IconName } from "@openportrait/ui";
import { api, type InternetStatus } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { tunnelSummary, useInternet } from "../../lib/useInternet.js";

const CF_DASH = "https://dash.cloudflare.com/";
const CF_TUNNELS = "https://one.dash.cloudflare.com/";

interface CheckResult {
  ok: boolean;
  code: string;
  message: string;
}

export function Step({ n, state, title, children, aside }: { n: number; state: "done" | "current" | "todo"; title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <li className={`step ${state}`}>
      <span className="step-num" aria-hidden="true">
        {state === "done" ? <Icon name="check" width={16} height={16} /> : n}
      </span>
      <div className="step-body">
        <h3>
          {title}
          {state === "done" ? <span className="sr-only">(done)</span> : null}
          {aside}
        </h3>
        {children}
      </div>
    </li>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="btn sm" href={href} target="_blank" rel="noreferrer noopener" style={{ alignSelf: "flex-start" }}>
      {children} <Icon name="external" width={15} height={15} />
    </a>
  );
}

function StatusPanel({ status, check, checking, onCheck }: { status: InternetStatus | null; check: CheckResult | null; checking: boolean; onCheck: () => void }) {
  const s = tunnelSummary(status);
  const t = status?.tunnel;
  let orb: { tone: string; icon: IconName } = { tone: "", icon: "cloud" };
  let headline = "Checking your connection…";
  let sub: ReactNode = "";
  if (status && t) {
    if (t.state === "connected") {
      orb = { tone: "ok", icon: "globe" };
      headline = "Your studio is online";
      sub = status.publicUrl ? status.publicUrl.replace(/^https?:\/\//, "") : "Connected. Add a public hostname in Cloudflare (step 4).";
    } else if (!t.installed) {
      orb = { tone: "warn", icon: "alert" };
      headline = "Built-in tunnel not available";
      sub = "This build doesn't include cloudflared. See “Use your own cloudflared” below.";
    } else if (!t.configured) {
      headline = "Not online yet";
      sub = "Follow the steps below to connect a Cloudflare Tunnel. No router changes needed.";
    } else if (t.state === "starting" || t.state === "reconnecting") {
      orb = { tone: "", icon: "refresh" };
      headline = t.state === "starting" ? "Connecting to Cloudflare…" : "Reconnecting to Cloudflare…";
      sub = "This usually takes a few seconds.";
    } else {
      orb = { tone: "bad", icon: "alert" };
      headline = "The tunnel can't connect";
      sub = t.lastError ?? "cloudflared stopped. It will retry automatically.";
    }
  }
  return (
    <section className="panel">
      <div className="panel-body">
        <div className="net-status">
          <div className="big">
            <span className={`orb ${orb.tone}`}>{status && (t?.state === "starting" || t?.state === "reconnecting") ? <Spinner /> : <Icon name={orb.icon} />}</span>
            <div style={{ minWidth: 0 }}>
              <h2>{headline}</h2>
              <p className="sub">{sub}</p>
            </div>
          </div>
          <div className="form-actions">
            <StatusChip tone={s.tone} pulse={s.tone === "info"}>
              {s.label}
            </StatusChip>
            {status?.publicUrl ? (
              <Button size="sm" icon="refresh" loading={checking} onClick={onCheck}>
                Test from outside
              </Button>
            ) : null}
          </div>
        </div>
        {check ? (
          <Callout tone={check.ok ? "ok" : "warn"} title={check.ok ? "It works" : "The outside test didn't pass"}>
            {check.message}
          </Callout>
        ) : null}
      </div>
    </section>
  );
}

export function InternetSettingsPage() {
  const { status, setStatus, error } = useInternet(3000);
  const toast = useToast();
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);

  const saveToken = useSubmit(() => api<InternetStatus>("/internet/token", { method: "PUT", body: { token } }));
  const saveUrl = useSubmit(() => api<InternetStatus>("/internet/public-url", { method: "PUT", body: { url: urlDraft ?? "" } }));

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck(await api<CheckResult>("/internet/check", { method: "POST" }));
    } catch (e) {
      setCheck({ ok: false, code: "error", message: e instanceof Error ? e.message : "The test couldn't run." });
    } finally {
      setChecking(false);
    }
  };

  const onToken = async (e: FormEvent) => {
    e.preventDefault();
    const next = await saveToken.submit();
    if (!next) return;
    setStatus(next);
    setToken("");
    setReplacing(false);
    setCheck(null);
    toast("Token saved. Connecting…");
  };

  const removeToken = async () => {
    if (!window.confirm("Disconnect the tunnel? Clients won't be able to reach your studio until you connect again.")) return;
    setStatus(await api<InternetStatus>("/internet/token", { method: "DELETE" }));
    setCheck(null);
    toast("Tunnel disconnected");
  };

  const onUrl = async (e: FormEvent) => {
    e.preventDefault();
    const next = await saveUrl.submit();
    if (!next) return;
    setStatus(next);
    setUrlDraft(null);
    setCheck(null);
    toast(next.publicUrl ? "Public address saved" : "Public address cleared");
  };

  const setTrust = async (v: boolean) => {
    setStatus(await api<InternetStatus>("/internet/trust-cloudflare", { method: "PUT", body: { trustCloudflare: v } }));
  };

  if (error && !status) return <Callout tone="bad" title="Couldn't load internet settings">{error}</Callout>;

  const t = status?.tunnel;
  const configured = !!t?.configured;
  const connected = t?.state === "connected";
  const hasHost = (t?.hostnames.length ?? 0) > 0 || status?.publicUrlSource === "settings" || status?.publicUrlSource === "template";
  const checked = check?.ok === true;
  const done = [configured, configured, configured && connected, connected && hasHost, checked];
  const current = done.findIndex((d) => !d);
  const stateOf = (i: number) => (done[i] ? "done" : i === current ? "current" : "todo") as "done" | "current" | "todo";
  const port = status?.lan.port ?? 8080;
  const showTokenForm = !configured || replacing;

  return (
    <>
      <StatusPanel status={status} check={check} checking={checking} onCheck={runCheck} />

      <Panel title="Connect a Cloudflare Tunnel" description="A tunnel lets clients reach OpenPortrait securely without opening ports on your router. Creating a tunnel doesn't need a credit card.">
        <ol className="steps" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <Step n={1} state={stateOf(0)} title="Have a domain on Cloudflare">
            <p>You need a domain, such as yourstudio.com, using Cloudflare for DNS. If yours isn't there yet, add it in Cloudflare and follow their steps to switch nameservers.</p>
            <ExternalLink href={CF_DASH}>Open Cloudflare</ExternalLink>
          </Step>

          <Step n={2} state={stateOf(1)} title="Create a tunnel">
            <ol>
              <li>
                In Cloudflare, open <b>Networks</b>, then <b>Tunnels</b>.
              </li>
              <li>
                Choose <b>Create a tunnel</b>, and name it <span className="mono">openportrait</span>.
              </li>
              <li>
                Choose your operating system and copy the install command. You don't run it, because OpenPortrait already includes cloudflared. Paste it in the next step, and OpenPortrait finds the token in it.
              </li>
            </ol>
            <ExternalLink href={CF_TUNNELS}>Open Tunnels</ExternalLink>
          </Step>

          <Step
            n={3}
            state={stateOf(2)}
            title="Paste the token"
            aside={
              configured ? (
                <StatusChip tone={connected ? "ok" : t?.state === "error" ? "bad" : "info"} pulse={!connected && t?.state !== "error"}>
                  {connected ? `Connected · ${t?.connections} link${t?.connections === 1 ? "" : "s"}` : t?.state === "error" ? "Not connecting" : "Connecting"}
                </StatusChip>
              ) : null
            }
          >
            {t && !t.installed ? (
              <Callout tone="warn" title="cloudflared isn't included in this build">
                Use the official OpenPortrait image, or run cloudflared yourself (see Advanced below).
              </Callout>
            ) : null}
            {configured && !replacing ? (
              <>
                <p>
                  {t?.tokenSource === "template"
                    ? "A token is set in the container template (CLOUDFLARE_TUNNEL_TOKEN)."
                    : "A token is saved. It's stored encrypted and never shown again."}
                </p>
                {t?.state === "error" && t.lastError ? <Callout tone="bad">{t.lastError}</Callout> : null}
                <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                  <Button size="sm" icon="key" onClick={() => setReplacing(true)}>
                    Replace token
                  </Button>
                  {t?.tokenSource === "settings" ? (
                    <Button size="sm" variant="ghost" className="danger" onClick={removeToken}>
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
            {showTokenForm && t?.installed !== false ? (
              <form onSubmit={onToken} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Field label="Tunnel token or install command" error={saveToken.fieldErrors.token ?? saveToken.error} hint="It starts with eyJ… and is very long. Pasting the whole command is fine.">
                  {(p) => <TextArea {...p} className="mono" rows={3} value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" placeholder="cloudflared service install eyJhIjoi…" />}
                </Field>
                <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                  <Button type="submit" variant="primary" loading={saveToken.busy} disabled={!token.trim()}>
                    Save and connect
                  </Button>
                  {replacing ? (
                    <Button variant="ghost" onClick={() => setReplacing(false)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : null}
          </Step>

          <Step n={4} state={stateOf(3)} title="Add a public hostname">
            <p>
              Open your tunnel, go to the <b>Routes</b> tab, click <b>Add route</b>, and choose <b>Published application</b>. Enter these values. A subdomain like <span className="mono">studio</span> works well.
            </p>
            <div className="values">
              <span>Subdomain</span>
              <CopyValue value="studio" label="subdomain" />
              <span>Domain</span>
              <span style={{ color: "var(--ink)" }}>Your domain</span>
              <span>Service URL</span>
              <CopyValue value={`http://localhost:${port}`} label="service URL" />
            </div>
            <p className="hint">Cloudflare creates the DNS record for you.</p>
            {t?.hostnames.length ? (
              <Callout tone="ok" title="Hostname found">
                Your tunnel serves {t.hostnames.join(", ")}.
              </Callout>
            ) : connected ? (
              <p className="hint">OpenPortrait picks up the hostname automatically once you save it in Cloudflare.</p>
            ) : null}
          </Step>

          <Step n={5} state={stateOf(4)} title="Test it from the outside">
            <p>OpenPortrait asks Cloudflare for your public address and checks the answer comes back from this server.</p>
            <Button size="sm" variant={current === 4 ? "primary" : "default"} icon="refresh" loading={checking} onClick={runCheck} disabled={!status?.publicUrl} style={{ alignSelf: "flex-start" }}>
              Run the test
            </Button>
          </Step>
        </ol>
      </Panel>

      <Panel title="Protect your back office (optional)" description="Adds a Cloudflare sign-in in front of the studio pages, on top of your OpenPortrait password. OpenPortrait already has its own login, so you can skip this and still finish setup. Cloudflare Access asks for a credit or debit card before it opens. It's $0 for up to 50 users.">
        <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-2)" }}>
          <li>
            In Zero Trust, open <b>Access controls</b>, then <b>Applications</b>. Click <b>Create new application</b> and choose <b>Self-hosted and private</b>.
          </li>
          <li>Add your public hostname with this one path. Client pages like galleries and booking stay public.</li>
        </ol>
        <div className="values">
          <span>Path</span>
          <CopyValue value="studio" label="studio path" />
        </div>
        <p className="hint">
          Don't add <span className="mono">api/studio</span> or <span className="mono">mcp</span>. Covering them makes OpenPortrait show "Can't reach OpenPortrait", and it blocks Claude's connector. Then add a policy that allows only your email address (and your staff's).
        </p>
      </Panel>

      <details className="more panel" style={{ padding: "var(--s4) var(--s5)" }}>
        <summary>Advanced</summary>
        <div>
          <form onSubmit={onUrl} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field
              label="Public address"
              error={saveUrl.fieldErrors.url ?? saveUrl.error}
              hint={
                status?.publicUrlSource === "tunnel"
                  ? "Detected from your tunnel. Set it here only to use a different address in emails and links."
                  : status?.publicUrlSource === "template"
                    ? "Set by APP_URL in the container template. A value here takes priority."
                    : "Used in emails and links sent to clients."
              }
            >
              {(p) => (
                <div className="input-row">
                  <TextInput {...p} value={urlDraft ?? (status?.publicUrlSource === "settings" ? status.publicUrl : "")} placeholder={status?.publicUrl || "https://studio.example.com"} onChange={(e) => setUrlDraft(e.target.value)} inputMode="url" />
                  <Button type="submit" loading={saveUrl.busy} disabled={urlDraft === null}>
                    Save
                  </Button>
                </div>
              )}
            </Field>
          </form>

          <div className="toggle-row">
            <div>
              <b>Use visitor addresses from Cloudflare</b>
              <span>Records each client's real IP address on signed contracts and download logs. Leave on unless you use a different proxy.</span>
            </div>
            <Switch label="Use visitor addresses from Cloudflare" checked={status?.trustCloudflare ?? true} onChange={setTrust} />
          </div>

          <div>
            <b style={{ fontSize: 14 }}>On your home network</b>
            <p className="hint" style={{ marginBottom: 8 }}>
              If the tunnel is ever down, you can still open OpenPortrait from home using the server's address and the port mapped in your container settings.
            </p>
            <div className="lan-list">
              {status?.platform === "unraid" ? <span className="hint">In Unraid, use the WebUI link on the Docker tab.</span> : null}
              {status?.lan.addresses.map((a) => (
                <StatusChip key={a}>{a}</StatusChip>
              ))}
            </div>
          </div>

          <div>
            <b style={{ fontSize: 14 }}>Use your own cloudflared</b>
            <p className="hint">
              Already run cloudflared in another container? Leave the token empty here, point a public hostname at this container (for example <span className="mono">http://openportrait:{port}</span>), and enter the public address above.
            </p>
          </div>
        </div>
      </details>
    </>
  );
}
