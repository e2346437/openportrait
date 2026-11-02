import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Button, Callout, CopyValue, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";

interface MfaStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

type Mode = "idle" | "password" | "scan" | "codes" | "disable" | "regen";

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`OpenPortrait recovery codes\nEach works once.\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "openportrait-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack">
      <Callout tone="warn">Save these now. They're the only way in if you lose your phone, and they won't be shown again.</Callout>
      <ul className="recovery-codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="mono">
            {c}
          </li>
        ))}
      </ul>
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        <CopyValue value={text} label="Copy all" />
        <Button variant="default" onClick={download}>
          Download .txt
        </Button>
      </div>
    </div>
  );
}

export function TwoStepPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = () => api<MfaStatus>("/auth/mfa").then(setStatus);
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!setup) return setQr("");
    void QRCode.toDataURL(setup.uri, { margin: 1, width: 192, errorCorrectionLevel: "M" }).then(setQr);
  }, [setup]);

  const reset = () => {
    setMode("idle");
    setPassword("");
    setCode("");
    setSetup(null);
  };

  const start = useSubmit(() => api<{ secret: string; uri: string }>("/auth/mfa/setup", { body: { password } }));
  const enable = useSubmit(() => api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { body: { code } }));
  const disable = useSubmit(() => api("/auth/mfa/disable", { body: { password, code } }));
  const regen = useSubmit(() => api<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { body: { password, code } }));

  const onStart = async (e: FormEvent) => {
    e.preventDefault();
    const res = await start.submit();
    if (!res) return;
    setSetup(res);
    setPassword("");
    setMode("scan");
  };
  const onEnable = async (e: FormEvent) => {
    e.preventDefault();
    const res = await enable.submit();
    if (!res) return;
    setCodes(res.recoveryCodes);
    setSetup(null);
    setCode("");
    setMode("codes");
    await load();
    toast("Two-step sign-in is on. Other devices were signed out.");
  };
  const onDisable = async (e: FormEvent) => {
    e.preventDefault();
    if ((await disable.submit()) === undefined) return;
    reset();
    await load();
    toast("Two-step sign-in is off.");
  };
  const onRegen = async (e: FormEvent) => {
    e.preventDefault();
    const res = await regen.submit();
    if (!res) return;
    setCodes(res.recoveryCodes);
    setPassword("");
    setCode("");
    setMode("codes");
    await load();
  };

  if (!status) {
    return (
      <Panel title="Two-step sign-in">
        <Spinner label="Loading" />
      </Panel>
    );
  }

  return (
    <Panel
      title="Two-step sign-in"
      description="After your password, sign in with a 6-digit code from an authenticator app on your phone."
      actions={status.enabled ? <StatusChip tone="ok">On</StatusChip> : <StatusChip tone="neutral">Off</StatusChip>}
    >
      {mode === "idle" && !status.enabled ? (
        <div className="stack">
          <p className="hint">Works with any authenticator app, such as Google Authenticator, Microsoft Authenticator, 1Password or Authy. It protects against a stolen or guessed password.</p>
          <div>
            <Button variant="primary" onClick={() => setMode("password")}>
              Turn on
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "password" ? (
        <form onSubmit={onStart} noValidate className="stack">
          {start.error ? <Callout tone="bad">{start.error}</Callout> : null}
          <Field label="Confirm your password" error={start.fieldErrors.password}>
            {(p) => <TextInput {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
          </Field>
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <Button type="submit" variant="primary" loading={start.busy} disabled={!password}>
              Continue
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "scan" && setup ? (
        <form onSubmit={onEnable} noValidate className="stack">
          <ol className="mfa-steps">
            <li>Open your authenticator app and add an account by scanning this code.</li>
          </ol>
          <div className="mfa-scan">
            {qr ? <img src={qr} width={192} height={192} alt="QR code for your authenticator app" /> : <div className="mfa-qr-wait" />}
            <div className="stack">
              <p className="hint">Can't scan? Enter this key instead:</p>
              <CopyValue value={setup.secret} label="Copy key" />
            </div>
          </div>
          {enable.error ? <Callout tone="bad">{enable.error}</Callout> : null}
          <Field label="Then enter the 6-digit code it shows" error={enable.fieldErrors.code}>
            {(p) => <TextInput {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="mfa-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />}
          </Field>
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <Button type="submit" variant="primary" loading={enable.busy} disabled={code.replace(/\s/g, "").length !== 6}>
              Verify and turn on
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "codes" && codes ? (
        <div className="stack">
          <RecoveryCodes codes={codes} />
          <div>
            <Button
              variant="primary"
              onClick={() => {
                setCodes(null);
                reset();
              }}
            >
              I've saved them
            </Button>
          </div>
        </div>
      ) : null}

      {status.enabled && (mode === "idle" || mode === "disable" || mode === "regen") ? (
        <div className="stack">
          {mode === "idle" ? (
            <>
              <p className="hint">
                {status.recoveryCodesLeft} recovery {status.recoveryCodesLeft === 1 ? "code" : "codes"} left.
                {status.recoveryCodesLeft <= 2 ? " Make a new set soon." : ""}
              </p>
              <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                <Button variant="default" onClick={() => setMode("regen")}>
                  New recovery codes
                </Button>
                <Button variant="danger" onClick={() => setMode("disable")}>
                  Turn off
                </Button>
              </div>
            </>
          ) : (
            <form onSubmit={mode === "disable" ? onDisable : onRegen} noValidate className="stack">
              {(mode === "disable" ? disable : regen).error ? <Callout tone="bad">{(mode === "disable" ? disable : regen).error}</Callout> : null}
              <p className="hint">{mode === "disable" ? "Confirm with your password and a current code (or a recovery code)." : "This replaces your old codes. Confirm with your password and a current code."}</p>
              <div className="form-grid">
                <Field label="Password">
                  {(p) => <TextInput {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
                </Field>
                <Field label="Code" error={(mode === "disable" ? disable : regen).fieldErrors.code}>
                  {(p) => <TextInput {...p} autoComplete="one-time-code" className="mfa-code" value={code} onChange={(e) => setCode(e.target.value)} />}
                </Field>
              </div>
              <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                <Button type="submit" variant={mode === "disable" ? "danger" : "primary"} loading={(mode === "disable" ? disable : regen).busy} disabled={!password || !code}>
                  {mode === "disable" ? "Turn off" : "Make new codes"}
                </Button>
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
