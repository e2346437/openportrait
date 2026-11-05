import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, Callout, copyText, Dialog, EmptyState, Field, Panel, Segmented, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { useLoad } from "../lib/useLoad.js";
import { useSubmit } from "../lib/useForm.js";
import { SwitchRow } from "./SwitchRow.js";
import { CameraHandOff, handOffText, type CameraConnect, type HandOffCamera } from "./CameraHandOff.js";

/** What an add-on's crew panel answers. See docs/extensions.md, "Crew panel". */
interface CameraStatus {
  state: "none" | "waiting" | "ok" | "off";
  label?: string;
  detail?: string;
}
interface CrewPerson {
  id: string;
  name: string;
  roleLabel: string;
  detail?: string;
  /** Dollars, "150.00", or null when no fee is set. */
  fee?: string | null;
  paid?: boolean;
  camera: CameraStatus;
  signin?: boolean;
}
interface CrewState {
  enabled: boolean;
  message?: string;
  people: CrewPerson[];
  /** People who aren't on this shoot yet. */
  directory: Array<{ id: string; name: string; hint?: string }>;
  /** Camera logins nobody uses yet. */
  cameras: Array<{ value: string; label: string }>;
  roles: Array<{ value: string; label: string }>;
  canSignin: boolean;
}
interface CameraResult {
  ok: boolean;
  camera?: HandOffCamera & { id: string };
  signin?: { email: string; password: string };
}
interface UploadInfo {
  settings: { protocol: "sftp" | "ftp" | "ftps" };
  connect: CameraConnect;
  status: { state: "open" | "closed" | "error" };
}

type CameraMode = "new" | "existing" | "none";
const CHIP: Record<CameraStatus["state"], { tone: "ok" | "warn" | "neutral" | "bad"; text: string }> = {
  ok: { tone: "ok", text: "Connected" },
  waiting: { tone: "warn", text: "Login created, hasn't connected" },
  none: { tone: "neutral", text: "No camera login" },
  off: { tone: "bad", text: "Login turned off" },
};

/** The shoot's crew: add people (creating them on the spot), set up or fix their camera logins, and see who has connected. */
export function CrewPanel({ shootId, extId, route }: { shootId: string; extId: string; route: string }) {
  const base = `/extensions/${extId}${route}/shoots/${encodeURIComponent(shootId)}`;
  const { data, error, reload } = useLoad<CrewState>(base);
  const upload = useLoad<UploadInfo>("/upload");
  const toast = useToast();
  const [adding, setAdding] = useState<{ forPerson?: CrewPerson } | null>(null);
  const [handOff, setHandOff] = useState<{ title: string; camera: HandOffCamera; signin?: { email: string; password: string } } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<CrewPerson | null>(null);
  const [removing, setRemoving] = useState<CrewPerson | null>(null);
  const [feeFor, setFeeFor] = useState<CrewPerson | null>(null);
  const [feeText, setFeeText] = useState("");
  const feeSave = useSubmit(() => api(`/extensions/${extId}/shoots/${encodeURIComponent(shootId)}/fee`, { method: "POST", body: { photographerId: feeFor!.id, fee: feeText } }));

  // Camera health changes while a shooter is setting up: keep it fresh.
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === "visible" && reload(), 15000);
    return () => window.clearInterval(t);
  }, [reload]);

  if (error && !data) return <Callout tone="bad" title="Couldn't load photographers">{error}</Callout>;
  if (!data) return <Panel title="Photographers"><Spinner label="Loading" /></Panel>;
  if (!data.enabled) return null;

  const camAction = async (p: CrewPerson, body: object, done?: string) => {
    try {
      const r = await api<CameraResult>(`${base}/people/${encodeURIComponent(p.id)}/camera`, { method: "POST", body });
      if (r.camera) setHandOff({ title: `Set up ${p.name}'s camera`, camera: r.camera });
      if (done) toast(done);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "bad");
    }
  };

  return (
    <Panel
      title="Photographers"
      description="Who is shooting this one. Files from a second shooter's camera are filed under their name."
      actions={
        data.people.length ? (
          <Button variant="primary" icon="plus" onClick={() => setAdding({})}>
            Add photographer
          </Button>
        ) : undefined
      }
    >
      {data.message ? <Callout tone="warn">{data.message}</Callout> : null}
      {data.people.length === 0 ? (
        <EmptyState icon="camera" title="Only you so far" action={<Button variant="primary" icon="plus" onClick={() => setAdding({})}>Add photographer</Button>}>
          Add a second shooter and give them their own camera login, so their photos stay separate from yours.
        </EmptyState>
      ) : (
        <ul className="crew-list">
          {data.people.map((p) => {
            const chip = CHIP[p.camera.state];
            return (
              <li key={p.id} className="crew-row">
                <Avatar name={p.name} size={36} />
                <div className="crew-who">
                  <b>{p.name}</b>
                  <small>{[p.roleLabel, p.detail].filter(Boolean).join(" · ")}</small>
                </div>
                <div className="crew-cam">
                  <StatusChip tone={chip.tone}>{p.camera.detail ?? chip.text}</StatusChip>
                  {p.camera.state === "none" ? (
                    <Button size="sm" variant="primary" onClick={() => setAdding({ forPerson: p })}>
                      Set up camera
                    </Button>
                  ) : null}
                  <div className="crew-menu">
                    <Button size="sm" variant="ghost" iconRight="chevronDown" aria-label={`More for ${p.name}`} aria-haspopup="menu" aria-expanded={menu === p.id} onClick={() => setMenu(menu === p.id ? null : p.id)}>More</Button>
                    {menu === p.id ? (
                      <div className="crew-menu-pop" role="menu" onMouseLeave={() => setMenu(null)}>
                        {p.camera.state === "none" ? (
                          <button role="menuitem" type="button" onClick={() => { setMenu(null); setAdding({ forPerson: p }); }}>Set up camera login…</button>
                        ) : (
                          <>
                            <button role="menuitem" type="button" onClick={() => { setMenu(null); setConfirmReset(p); }}>New password…</button>
                            <button role="menuitem" type="button" onClick={() => { setMenu(null); void camAction(p, { action: p.camera.state === "off" ? "enable" : "disable" }, p.camera.state === "off" ? "Login turned on" : "Login turned off"); }}>
                              {p.camera.state === "off" ? "Turn login on" : "Turn login off"}
                            </button>
                          </>
                        )}
                        <button role="menuitem" type="button" onClick={() => { setMenu(null); setFeeText(p.fee ?? ""); setFeeFor(p); }}>{p.fee ? "Change fee…" : "Set fee…"}</button>
                        {p.fee && !p.paid ? (
                          <button
                            role="menuitem"
                            type="button"
                            onClick={async () => {
                              setMenu(null);
                              try {
                                await api(`/extensions/${extId}/shoots/${encodeURIComponent(shootId)}/paid`, { method: "POST", body: { photographerId: p.id } });
                                toast(`Marked ${p.name} paid`);
                                reload();
                              } catch (e) {
                                toast(e instanceof Error ? e.message : "That didn't work.", "bad");
                              }
                            }}
                          >
                            Mark fee paid
                          </button>
                        ) : null}
                        <button role="menuitem" type="button" className="danger" onClick={() => { setMenu(null); setRemoving(p); }}>Remove from this shoot</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <AddSheet
          base={base}
          state={data}
          forPerson={adding.forPerson}
          onClose={() => setAdding(null)}
          onDone={(r, name) => {
            setAdding(null);
            reload();
            if (r.camera) setHandOff({ title: `Set up ${name}'s camera`, camera: r.camera, signin: r.signin });
            else if (r.signin) setHandOff({ title: `${name}'s sign-in`, camera: { label: name, username: "", folder: "", password: "" }, signin: r.signin });
            else toast(`${name} added`);
          }}
        />
      ) : null}
      <HandOffDialog value={handOff} upload={upload.data ?? null} onClose={() => setHandOff(null)} />
      <Dialog
        open={confirmReset !== null}
        onClose={() => setConfirmReset(null)}
        title="Make a new password?"
        description="The old password stops working for new sign-ins straight away. A camera already connected stays connected until it disconnects."
        footer={
          <>
            <Button onClick={() => setConfirmReset(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { const p = confirmReset!; setConfirmReset(null); void camAction(p, { action: "reset" }); }}>
              Make new password
            </Button>
          </>
        }
      >
        <p>You'll see the new password once, to give to {confirmReset?.name}.</p>
      </Dialog>
      <Dialog
        open={feeFor !== null}
        onClose={() => setFeeFor(null)}
        title={`Fee for ${feeFor?.name ?? ""}`}
        description="A record of what you'll pay them for this shoot. Nothing is paid from here."
        footer={
          <>
            <Button onClick={() => setFeeFor(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={feeSave.busy}
              onClick={async () => {
                if ((await feeSave.submit()) !== undefined) {
                  setFeeFor(null);
                  reload();
                }
              }}
            >
              Save fee
            </Button>
          </>
        }
      >
        {feeSave.error ? <Callout tone="bad">{feeSave.error}</Callout> : null}
        <Field label="Fee (dollars)" error={feeSave.fieldErrors.fee}>
          {(p) => <TextInput {...p} inputMode="decimal" value={feeText} onChange={(e) => setFeeText(e.target.value)} autoFocus placeholder="150" />}
        </Field>
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? ""} from this shoot?`}
        description="Their camera login and any photos they sent are not touched."
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const p = removing!;
                setRemoving(null);
                try {
                  await api(`${base}/people/${encodeURIComponent(p.id)}`, { method: "DELETE" });
                  reload();
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Couldn't remove them.", "bad");
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </Panel>
  );
}

function HandOffDialog({ value, upload, onClose }: { value: { title: string; camera: HandOffCamera; signin?: { email: string; password: string } } | null; upload: UploadInfo | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    setCopied(false);
    setConfirmClose(false);
  }, [value]);
  if (!value) return null;
  const hasCamera = value.camera.username !== "";
  const close = () => (copied || !hasCamera ? onClose() : setConfirmClose(true));
  return (
    <Dialog
      open
      onClose={close}
      title={value.title}
      description={hasCamera ? "Type these into the camera's FTP or SFTP settings." : undefined}
      footer={
        confirmClose ? (
          <>
            <span className="hint">You haven't copied the password. Close anyway?</span>
            <Button onClick={() => setConfirmClose(false)}>Go back</Button>
            <Button variant="danger" onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            {hasCamera && upload ? (
              <Button
                icon="copy"
                onClick={async () => {
                  if (await copyText(handOffText(upload.settings.protocol, upload.connect, value.camera))) setCopied(true);
                }}
              >
                Copy all as text
              </Button>
            ) : null}
            <Button variant="primary" onClick={onClose}>
              I've saved it, done
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {hasCamera && upload?.status.state === "closed" ? (
          <Callout tone="info" title="The camera server is closed right now">It opens when you start a live view, or open it for a while under Settings &gt; Camera upload.</Callout>
        ) : null}
        {hasCamera && upload ? <div onClickCapture={() => setCopied(true)}><CameraHandOff protocol={upload.settings.protocol} connect={upload.connect} camera={value.camera} /></div> : hasCamera ? <Spinner label="Loading" /> : null}
        {value.signin ? (
          <Callout tone="info" title={`Sign-in for ${value.signin.email}`}>
            One-time password: <code>{value.signin.password}</code>. Shown only now.
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}

function AddSheet({ base, state, forPerson, onClose, onDone }: { base: string; state: CrewState; forPerson?: CrewPerson; onClose: () => void; onDone: (r: CameraResult, name: string) => void }) {
  const [query, setQuery] = useState(forPerson?.name ?? "");
  const [pickedId, setPickedId] = useState<string | null>(forPerson?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState(state.roles.find((r) => r.value === "second")?.value ?? state.roles[0]?.value ?? "");
  const [fee, setFee] = useState("");
  const [mode, setMode] = useState<CameraMode>("new");
  const [camLabel, setCamLabel] = useState("");
  const [existingId, setExistingId] = useState(state.cameras[0]?.value ?? "");
  const [expire, setExpire] = useState(true);
  const [signin, setSignin] = useState(false);
  const [email, setEmail] = useState("");
  const name = (forPerson?.name ?? (pickedId ? state.directory.find((d) => d.id === pickedId)?.name : query) ?? "").trim();
  const chosen = forPerson !== undefined || pickedId !== null || creating;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.directory.filter((d) => !q || d.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, state.directory]);
  const exact = state.directory.some((d) => d.name.toLowerCase() === query.trim().toLowerCase());
  const near = !exact && query.trim().length > 2 ? state.directory.find((d) => d.name.toLowerCase().startsWith(query.trim().toLowerCase().slice(0, -1))) : undefined;

  const defaultCam = `${name.split(" ")[0] || "Their"}'s camera`;
  const save = useSubmit(() =>
    api<CameraResult>(`${base}/people`, {
      method: "POST",
      body: {
        ...(forPerson ? { personId: forPerson.id } : pickedId ? { personId: pickedId } : { name: query.trim() }),
        role,
        fee: fee.trim() || undefined,
        camera: { mode, label: camLabel.trim() || defaultCam, existingId: mode === "existing" ? existingId : undefined },
        expireAfterShoot: mode !== "none" && expire,
        signinEmail: signin ? email.trim() : undefined,
      },
    }),
  );
  const submit = async () => {
    const r = await save.submit();
    if (r) onDone(r, name);
  };
  const hasExisting = forPerson !== undefined || pickedId !== null;
  const cameraOptions: Array<{ value: CameraMode; label: string }> = [
    { value: "new", label: "Create a new login" },
    ...(state.cameras.length ? [{ value: "existing" as const, label: `Use an existing one (${state.cameras.length})` }] : []),
    { value: "none", label: "Skip for now" },
  ];

  return (
    <Dialog
      open
      onClose={() => !save.busy && onClose()}
      title={chosen && name ? `Add ${name}` : "Add a photographer"}
      description={forPerson ? "Set up a camera login for this person." : "Find someone you've worked with, or create them here."}
      footer={
        <>
          <Button disabled={save.busy} onClick={onClose}>Cancel</Button>
          {chosen ? (
            <Button variant="primary" loading={save.busy} disabled={!name} onClick={submit}>
              {mode === "new" ? `${forPerson ? "Create login" : `Add ${name.split(" ")[0] || "them"} and create login`}` : "Add to shoot"}
            </Button>
          ) : null}
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (chosen) void submit(); }} noValidate className="stack">
        {save.error ? <Callout tone="bad">{save.error}</Callout> : null}
        {!forPerson ? (
          <Field label="Who is it?" error={save.fieldErrors.name}>
            {(p) => (
              <TextInput {...p} value={query} autoFocus autoComplete="off" disabled={chosen} onChange={(e) => { setQuery(e.target.value); setPickedId(null); setCreating(false); }} />
            )}
          </Field>
        ) : null}
        {!chosen ? (
          <div className="crew-pick" role="listbox" aria-label="People">
            {matches.map((d) => (
              <button key={d.id} type="button" role="option" aria-selected="false" onClick={() => setPickedId(d.id)}>
                <Avatar name={d.name} size={28} />
                <span>{d.name}</span>
                {d.hint ? <small>{d.hint}</small> : null}
              </button>
            ))}
            {query.trim() ? (
              <button type="button" role="option" aria-selected="false" className="create" onClick={() => setCreating(true)}>
                <span className="crew-plus" aria-hidden>+</span>
                <span>Create “{query.trim()}” as a new photographer</span>
              </button>
            ) : (
              <p className="hint">Type a name. People you've added before appear first.</p>
            )}
            {near ? <p className="hint">Did you mean {near.name}?</p> : null}
          </div>
        ) : null}
        {chosen ? (
          <>
            {!forPerson ? (
              <button type="button" className="linklike" onClick={() => { setPickedId(null); setCreating(false); }}>
                Change person
              </button>
            ) : null}
            {!forPerson ? (
              <div className="crew-two">
                <Field label="Role">
                  {(p) => (
                    <select {...p} className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                      {state.roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Fee for this shoot" hint="A record only. Nothing is paid from here.">
                  {(p) => <TextInput {...p} inputMode="decimal" placeholder="150" value={fee} onChange={(e) => setFee(e.target.value)} />}
                </Field>
              </div>
            ) : null}
            <div className="field">
              <label>Camera login</label>
              <Segmented value={mode} onChange={(v) => setMode(v as CameraMode)} options={cameraOptions} label="Camera login" />
            </div>
            {mode === "new" ? (
              <>
                <Field label="Camera name" hint="Names their folder in Incoming. Edit it if you like." error={save.fieldErrors.camera}>
                  {(p) => <TextInput {...p} value={camLabel} placeholder={defaultCam} onChange={(e) => setCamLabel(e.target.value)} />}
                </Field>
                <Callout tone="info">You'll see the address, username and a one-time password next. This login can only send photos to its own folder. It can't read or delete anything.</Callout>
                <SwitchRow checked={expire} onChange={setExpire} label="Turn the login off after the shoot" hint="Recommended for second shooters. It switches off 7 days after the shoot date, and you can turn it back on." />
              </>
            ) : null}
            {mode === "existing" ? (
              <Field label="Login" error={save.fieldErrors.camera}>
                {(p) => (
                  <select {...p} className="input" value={existingId} onChange={(e) => setExistingId(e.target.value)}>
                    {state.cameras.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                )}
              </Field>
            ) : null}
            {!forPerson && state.canSignin && !hasExisting ? (
              <SwitchRow checked={signin} onChange={setSignin} label="Also let them sign in to see this shoot" hint="Optional. They only ever see shoots they're on." />
            ) : null}
            {signin && !forPerson ? (
              <Field label="Their email" error={save.fieldErrors.signinEmail}>
                {(p) => <TextInput {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
              </Field>
            ) : null}
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
