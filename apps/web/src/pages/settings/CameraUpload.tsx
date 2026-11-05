import { useEffect, useState } from "react";
import { Button, Callout, CopyValue, Dialog, EmptyState, Field, Icon, Panel, Spinner, StatusChip, TextArea, TextInput, useToast } from "@openportrait/ui";
import { CameraHandOff } from "../../components/CameraHandOff.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDate, formatTime, relative } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";

type Protocol = "sftp" | "ftp" | "ftps";
type Mode = "on_demand" | "scheduled" | "always_on";
interface Window {
  days: number[];
  start: string;
  end: string;
}
interface Status {
  state: "open" | "closed" | "error";
  protocol: Protocol;
  mode: Mode;
  openReason: "always" | "schedule" | "manual" | "demand" | null;
  closesAt: number | null;
  opensAt: number | null;
  connections: number;
  transfers: number;
  port: number;
  passiveRange: { min: number; max: number } | null;
  lastError: string | null;
  lastFile: { name: string; camera: string; at: number } | null;
}
interface Settings {
  protocol: Protocol;
  mode: Mode;
  idleMinutes: number;
  schedule: Window[];
  sortByDay: boolean;
  passiveHost: string;
}
interface Camera {
  id: string;
  label: string;
  username: string;
  folder: string;
  hasKey: boolean;
  disabled: boolean;
  lastLoginAt: number | null;
  lastUploadAt: number | null;
  filesReceived: number;
  bytesReceived: number;
}
interface State {
  status: Status;
  settings: Settings;
  timezone: string;
  accounts: Camera[];
  events: Array<{ id: number; at: number; action: string; detail: Record<string, unknown> | null; ip: string | null }>;
  connect: { hosts: string[]; sftpPort: number; ftpPort: number; passiveMin: number; passiveMax: number; fingerprint: string; hasCert: boolean; lanConfigured: boolean };
}
interface NewCamera {
  id: string;
  label: string;
  username: string;
  folder: string;
  password: string;
}

const PROTOCOLS: Array<{ id: Protocol; title: string; badge?: string; text: string }> = [
  { id: "sftp", title: "SFTP", badge: "Recommended", text: "Encrypted, and needs one port. Use it on any camera that offers it." },
  { id: "ftps", title: "FTPS", text: "FTP with encryption. The camera must trust a certificate from this server." },
  { id: "ftp", title: "FTP", text: "For cameras that only speak plain FTP. Nothing is encrypted." },
];
const MODES: Array<{ id: Mode; title: string; badge?: string; tone?: "ok" | "bad"; text: string }> = [
  { id: "on_demand", title: "Only when needed", badge: "Recommended", tone: "ok", text: "Closed until you open it or start a live view, then closes itself after a quiet spell." },
  { id: "scheduled", title: "On a schedule", text: "Open on the days and hours you choose, such as during a Saturday session." },
  { id: "always_on", title: "Always open", badge: "Not recommended", tone: "bad", text: "A port stays open to your network around the clock, which is more to defend." },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DURATIONS = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 720, label: "12 hours" },
];

const bytes = (n: number) => (n < 1e3 ? `${n} B` : n < 1e6 ? `${Math.round(n / 1e3)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`);
const REASON: Record<string, string> = { always: "Always open", schedule: "Open on schedule", manual: "Opened by hand", demand: "Opened for a live view" };

/** Settings > Camera upload: which protocol, when the server is open, and the logins cameras use. */
export function CameraUploadSettingsPage() {
  const toast = useToast();
  const { me } = useSession();
  const tzLabel = me?.studio.timezone ?? "UTC";
  const { data, error, reload } = useLoad<State>("/upload");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [openFor, setOpenFor] = useState(60);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<NewCamera | null>(null);
  const [removing, setRemoving] = useState<Camera | null>(null);

  // Keep the status fresh while the page is open.
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === "visible" && reload(), 8000);
    return () => window.clearInterval(t);
  }, [reload]);
  useEffect(() => {
    if (data && !draft) setDraft(data.settings);
  }, [data, draft]);

  const save = useSubmit(() => api<State>("/upload/settings", { method: "PUT", body: draft }));

  if (error && !data) return <Callout tone="bad" title="Couldn't load camera upload settings">{error}</Callout>;
  if (!data || !draft) return <Spinner label="Loading" />;

  const { status, connect } = data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const when = (ms: number) => `${formatDate(ms, data.timezone, { weekday: "short" })} ${formatTime(ms, data.timezone)}`;

  const run = async (path: string, body?: object, message?: string) => {
    try {
      await api(path, { method: "POST", body: body ?? {} });
      if (message) toast(message);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "bad");
    }
  };

  const applySaved = (r: State) => {
    setConfirmAlways(false);
    setDraft(r.settings);
    toast("Saved");
    reload();
  };
  const onConfirmAlways = async () => {
    try {
      applySaved(await api<State>("/upload/settings", { method: "PUT", body: { ...draft, confirmAlwaysOn: true } }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't save.", "bad");
    }
  };

  const onSave = async () => {
    if (draft.mode === "always_on" && data.settings.mode !== "always_on") {
      setConfirmAlways(true);
      return;
    }
    const r = await save.submit();
    if (r) applySaved(r);
  };

  const orb = status.state === "open" ? "ok" : status.state === "error" ? "bad" : "";
  const headline = status.state === "open" ? "Open for cameras" : status.state === "error" ? "Couldn't open" : "Closed";
  const sub =
    status.state === "open"
      ? `${REASON[status.openReason ?? "manual"]}${status.closesAt ? `, closes ${when(status.closesAt)}` : ""}.`
      : status.state === "error"
        ? status.lastError
        : status.opensAt
          ? `Cameras can't connect. Opens ${when(status.opensAt)}.`
          : status.mode === "on_demand"
            ? "Cameras can't connect. It opens when you start a live view or open it here."
            : "Cameras can't connect right now.";

  return (
    <div className="stack">
      <Panel title="Camera upload" description="A built-in server your camera sends photos to. They land in Incoming, ready for the live view or for sorting into a shoot.">
        <div className="net-status">
          <div className="big">
            <div className={`orb ${orb}`}>
              <Icon name="camera" />
            </div>
            <div>
              <h2>{headline}</h2>
              <p className="sub">{sub}</p>
            </div>
          </div>
          <div className="up-actions">
            {status.state === "open" ? (
              <Button variant="default" icon="x" onClick={() => run("/upload/close", {}, "Closed")}>
                Close now
              </Button>
            ) : (
              <>
                <select className="input" aria-label="How long to stay open" value={openFor} onChange={(e) => setOpenFor(Number(e.target.value))}>
                  {DURATIONS.map((d) => (
                    <option key={d.minutes} value={d.minutes}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <Button variant="primary" icon="check" onClick={() => run("/upload/open", { minutes: openFor }, "Open for cameras")}>
                  Open now
                </Button>
              </>
            )}
          </div>
        </div>
        {status.state === "open" ? (
          <div className="up-facts">
            <StatusChip tone="ok" pulse>
              {status.protocol.toUpperCase()} on port {status.port}
            </StatusChip>
            <span>
              {status.connections} {status.connections === 1 ? "camera" : "cameras"} connected
            </span>
            {status.transfers ? <span>{status.transfers} receiving now</span> : null}
            {status.lastFile ? (
              <span>
                Last photo: {status.lastFile.name} from {status.lastFile.camera}, {relative(status.lastFile.at)}
              </span>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Protocol" description="What your camera uses to talk to this server. Pick the most secure one your camera supports.">
        <fieldset className="choice-set">
          <legend className="sr-only">Protocol</legend>
          <div className="choice-grid">
            {PROTOCOLS.map((p) => (
              <label key={p.id} className={`choice ${draft.protocol === p.id ? "on" : ""}`}>
                <input type="radio" name="protocol" checked={draft.protocol === p.id} onChange={() => set("protocol", p.id)} />
                <b>
                  {p.title} {p.badge ? <StatusChip tone="ok">{p.badge}</StatusChip> : null}
                </b>
                <span>{p.text}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {draft.protocol === "ftp" ? (
          <Callout tone="warn" title="Plain FTP isn't encrypted">
            The camera's password and your photos travel as readable text. Use it only on your home network, or over a WireGuard connection. Don't forward the FTP port from your router to the internet.
          </Callout>
        ) : null}
        {draft.protocol === "ftps" ? (
          <Callout tone="info" title="Load the certificate on your camera">
            Cameras that check certificates need this server's certificate saved on the memory card and imported as a root certificate. It's created the first time the server opens.{" "}
            {connect.hasCert ? (
              <a href="/api/studio/upload/ftps-certificate" download>
                Download the certificate
              </a>
            ) : (
              "Open the server once, then come back to download it."
            )}
          </Callout>
        ) : null}
        {draft.protocol !== "sftp" ? (
          <Field label="Address cameras connect back to" hint={`FTP sends photos over a second connection, so the server must tell the camera where to find it. Use this server's address on your network. Ports ${connect.passiveMin} to ${connect.passiveMax} must be published from the container.`} error={save.fieldErrors.passiveHost}>
            {(p) => (
              <div className="input-row">
                <TextInput {...p} value={draft.passiveHost} placeholder={connect.hosts[0] ?? "192.168.1.20"} onChange={(e) => set("passiveHost", e.target.value)} autoComplete="off" spellCheck={false} />
                {connect.hosts[0] && draft.passiveHost !== connect.hosts[0] ? (
                  <Button type="button" onClick={() => set("passiveHost", connect.hosts[0]!)}>
                    Use {connect.hosts[0]}
                  </Button>
                ) : null}
              </div>
            )}
          </Field>
        ) : null}
      </Panel>

      <Panel title="When is it open?" description="Keeping the upload server closed when you aren't shooting means nothing is listening for someone to try.">
        <fieldset className="choice-set">
          <legend className="sr-only">Access mode</legend>
          <div className="choice-grid">
            {MODES.map((m) => (
              <label key={m.id} className={`choice ${draft.mode === m.id ? "on" : ""}`}>
                <input type="radio" name="mode" checked={draft.mode === m.id} onChange={() => setDraft((d) => (d ? { ...d, mode: m.id, schedule: m.id === "scheduled" && d.schedule.length === 0 ? [{ days: [6], start: "09:00", end: "17:00" }] : d.schedule } : d))} />
                <b>
                  {m.title} {m.badge ? <StatusChip tone={m.tone ?? "neutral"}>{m.badge}</StatusChip> : null}
                </b>
                <span>{m.text}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {draft.mode === "on_demand" ? (
          <Field label="Close after" hint="Counted from the last photo, connection or live-view heartbeat. A photo that is still arriving is never cut off.">
            {(p) => (
              <select {...p} className="input" style={{ maxWidth: 220 }} value={draft.idleMinutes} onChange={(e) => set("idleMinutes", Number(e.target.value))}>
                {[10, 15, 30, 60, 120, 240].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : `${m / 60} ${m === 60 ? "hour" : "hours"}`} of quiet
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {draft.mode === "scheduled" ? <ScheduleEditor windows={draft.schedule} onChange={(w) => set("schedule", w)} tz={tzLabel} error={save.fieldErrors.schedule} /> : null}
        {draft.mode === "always_on" ? (
          <Callout tone="warn" title="Not recommended">
            An always-open server is reachable by anything that can get to its port, all day. Prefer "Only when needed", or keep it on a network only you can reach.
          </Callout>
        ) : null}

        <SwitchRow checked={draft.sortByDay} onChange={(v) => set("sortByDay", v)} label="Sort photos into a folder for each day" hint="A photo sent to a camera's top-level folder is filed under that day's date, such as Incoming/Nikon Z9/2026-11-14/." />

        {save.error ? <Callout tone="bad">{save.error}</Callout> : null}
        <div className="up-save">
          <Button variant="primary" loading={save.busy} disabled={!dirty} onClick={onSave}>
            Save changes
          </Button>
          {dirty ? (
            <Button variant="ghost" onClick={() => setDraft(data.settings)}>
              Discard
            </Button>
          ) : null}
          {dirty && draft.protocol !== data.settings.protocol && status.state === "open" ? <span className="hint">Changing the protocol restarts the server and disconnects cameras.</span> : null}
        </div>
      </Panel>

      <Panel
        title="Camera logins"
        description="Each camera gets its own login, limited to its own folder in Incoming. A login can send photos but can't download or delete them."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add a camera
          </Button>
        }
      >
        {data.accounts.length === 0 ? (
          <EmptyState icon="camera" title="No cameras yet" action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add a camera</Button>}>
            Add one login per camera. You'll get the server address, username and password to type into the camera.
          </EmptyState>
        ) : (
          <ul className="conn-list">
            {data.accounts.map((c) => (
              <li key={c.id}>
                <div>
                  <b>
                    {c.label} {c.disabled ? <StatusChip tone="warn">Disabled</StatusChip> : null}
                  </b>
                  <span>
                    Login <code>{c.username}</code> · folder <code>{c.folder}</code>
                    {c.hasKey ? " · key set" : ""}
                  </span>
                  <span>{c.lastUploadAt ? `${c.filesReceived} ${c.filesReceived === 1 ? "file" : "files"} (${bytes(c.bytesReceived)}), last ${relative(c.lastUploadAt)}` : c.lastLoginAt ? `Connected ${relative(c.lastLoginAt)}, no photos yet` : "Hasn't connected yet"}</span>
                </div>
                <div className="up-row-actions">
                  <Button size="sm" onClick={async () => {
                    try {
                      const r = await api<{ password: string }>(`/upload/accounts/${c.id}/reset-password`, { method: "POST", body: {} });
                      setCreated({ id: c.id, label: c.label, username: c.username, folder: c.folder, password: r.password });
                    } catch (e) {
                      toast(e instanceof Error ? e.message : "Couldn't reset the password.", "bad");
                    }
                  }}>
                    New password
                  </Button>
                  <Button size="sm" variant="ghost" onClick={async () => {
                    await api(`/upload/accounts/${c.id}`, { method: "PATCH", body: { disabled: !c.disabled } }).catch(() => undefined);
                    reload();
                  }}>
                    {c.disabled ? "Enable" : "Disable"}
                  </Button>
                  <Button size="sm" variant="danger" icon="trash" aria-label={`Remove ${c.label}`} onClick={() => setRemoving(c)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {draft.protocol === "sftp" ? (
        <Panel title="Server fingerprint" description="Some cameras and apps show this when they connect for the first time. If it matches, you're talking to your own server.">
          <CopyValue value={connect.fingerprint} label="fingerprint" />
        </Panel>
      ) : null}

      <Panel title="Recent activity" description="When the server opened and closed, and anyone who failed to sign in.">
        {data.events.length === 0 ? (
          <p className="hint">Nothing yet.</p>
        ) : (
          <ul className="activity">
            {data.events.map((e) => (
              <li key={e.id}>
                <Icon name={e.action === "upload.opened" ? "check" : e.action === "upload.blocked" || e.action === "upload.failed" || e.action === "upload.login_failed" ? "alert" : "clock"} width={16} height={16} />
                <span>{describe(e)}</span>
                <time>{relative(e.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <AddCameraDialog
        open={adding}
        protocol={data.settings.protocol}
        onClose={() => setAdding(false)}
        onCreated={(c) => {
          setAdding(false);
          setCreated(c);
          reload();
        }}
      />
      <Dialog
        open={created !== null}
        onClose={() => {
          setCreated(null);
          reload();
        }}
        title={created ? `Set up ${created.label}` : ""}
        description="Type these into the camera's FTP or SFTP settings. The password is shown only now."
        footer={<Button variant="primary" onClick={() => { setCreated(null); reload(); }}>Done</Button>}
      >
        {created ? (
          <CameraHandOff protocol={data.settings.protocol} connect={connect} camera={created} />
        ) : null}
      </Dialog>
      <Dialog
        open={confirmAlways}
        onClose={() => setConfirmAlways(false)}
        title="Keep the upload server open all the time?"
        description="Anyone who can reach its port can try to sign in, at any hour."
        footer={
          <>
            <Button onClick={() => setConfirmAlways(false)}>Keep it safer</Button>
            <Button variant="danger" loading={save.busy} onClick={onConfirmAlways}>
              Open it all the time
            </Button>
          </>
        }
      >
        <p>"Only when needed" gives you the same convenience with the port closed while you aren't shooting. Choose always-open only if the port is reachable from your own network and nothing else.</p>
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.label}?` : ""}
        description="The camera will no longer be able to connect. Photos it already sent stay in Incoming."
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!removing) return;
                await api(`/upload/accounts/${removing.id}`, { method: "DELETE" }).catch(() => undefined);
                setRemoving(null);
                toast("Removed");
                reload();
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p>You can add the camera again later with a new password.</p>
      </Dialog>
    </div>
  );
}

function describe(e: State["events"][number]): string {
  const d = e.detail ?? {};
  switch (e.action) {
    case "upload.opened":
      return `Opened (${String(d.reason ?? "")}, ${String(d.protocol ?? "").toUpperCase()})`;
    case "upload.closed":
      return `Closed (${String(d.reason ?? "").replace(/_/g, " ")})`;
    case "upload.failed":
      return `Couldn't open: ${String(d.error ?? "")}`;
    case "upload.login_failed":
      return `Failed sign-in as "${String(d.username ?? "")}" from ${e.ip ?? "unknown"}`;
    case "upload.blocked":
      return `Blocked ${e.ip ?? "an address"} for ${String(d.minutes ?? 15)} minutes after repeated failed sign-ins`;
    case "upload.settings":
      return "Settings changed";
    case "upload.camera_added":
      return `Camera added: ${String(d.label ?? "")}`;
    case "upload.camera_removed":
      return "Camera removed";
    case "upload.camera_password_reset":
      return "A camera password was reset";
    default:
      return e.action.replace("upload.", "").replace(/_/g, " ");
  }
}

function ScheduleEditor({ windows, onChange, tz, error }: { windows: Window[]; onChange: (w: Window[]) => void; tz: string; error?: string }) {
  const update = (i: number, patch: Partial<Window>) => onChange(windows.map((w, n) => (n === i ? { ...w, ...patch } : w)));
  return (
    <div className="sched">
      <p className="hint">Times are in your studio's time zone ({tz}). A window can run past midnight.</p>
      {windows.map((w, i) => (
        <div key={i} className="sched-row">
          <div className="sched-days" role="group" aria-label="Days">
            {DAY_ORDER.map((d) => (
              <button key={d} type="button" className={w.days.includes(d) ? "on" : ""} aria-pressed={w.days.includes(d)} onClick={() => update(i, { days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d] })}>
                {DAYS[d]}
              </button>
            ))}
          </div>
          <div className="sched-times">
            <input className="input" type="time" aria-label="Opens at" value={w.start} onChange={(e) => update(i, { start: e.target.value })} />
            <span>to</span>
            <input className="input" type="time" aria-label="Closes at" value={w.end} onChange={(e) => update(i, { end: e.target.value })} />
            <Button size="sm" variant="ghost" icon="trash" aria-label="Remove this window" onClick={() => onChange(windows.filter((_, n) => n !== i))} />
          </div>
        </div>
      ))}
      {error ? (
        <span className="error-text">
          <Icon name="alert" width={16} height={16} />
          {error}
        </span>
      ) : null}
      <div>
        <Button icon="plus" onClick={() => onChange([...windows, { days: windows.length ? [] : [6], start: "09:00", end: "17:00" }])}>
          Add a time window
        </Button>
      </div>
    </div>
  );
}

function AddCameraDialog({ open, protocol, onClose, onCreated }: { open: boolean; protocol: Protocol; onClose: () => void; onCreated: (c: NewCamera) => void }) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const add = useSubmit(() => api<NewCamera>("/upload/accounts", { method: "POST", body: { label, ...(key.trim() ? { publicKey: key } : {}) } }));
  useEffect(() => {
    if (open) {
      setLabel("");
      setKey("");
      setShowKey(false);
    }
  }, [open]);
  const submit = async () => {
    const r = await add.submit();
    if (r) onCreated(r);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a camera"
      description="Name it so you can tell logins apart. You'll get a username and password for it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.busy} onClick={submit}>
            Add camera
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="stack">
        {add.error ? <Callout tone="bad">{add.error}</Callout> : null}
        <Field label="Camera name" hint="For example Nikon Z9. It also names the folder in Incoming." error={add.fieldErrors.label}>
          {(p) => <TextInput {...p} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus autoComplete="off" />}
        </Field>
        {protocol === "sftp" ? (
          showKey ? (
            <Field label="SSH public key (optional)" hint="Most cameras sign in with a password and don't need this. Paste the one-line public key if a computer or app will use a key instead." error={add.fieldErrors.publicKey}>
              {(p) => <TextArea {...p} className="input mono" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />}
            </Field>
          ) : (
            <button type="button" className="linklike" onClick={() => setShowKey(true)}>
              Use an SSH key as well
            </button>
          )
        ) : null}
      </form>
    </Dialog>
  );
}
