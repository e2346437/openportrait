import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, Callout, Field, Icon, TextInput } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { useSession } from "../lib/session.js";
import { allTimezones, browserTimezone, prettyTimezone } from "../lib/timezones.js";
import { useSubmit } from "../lib/useForm.js";
import { AuthLayout } from "./AuthLayout.js";

/** Rough strength score 0–4: length, variety, and not just one repeated pattern. */
function score(pw: string): number {
  if (!pw) return 0;
  if (pw.length < 10 || new Set(pw).size < 5) return 1;
  let s = 2;
  if (pw.length >= 14) s++;
  if ((/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)) || /[^A-Za-z0-9]/.test(pw) || pw.trim().split(/\s+/).length >= 3) s++;
  return Math.min(s, 4);
}
const scoreLabel = ["", "Too short or easy to guess", "Okay", "Good", "Strong"];

export function SetupPage() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const go = async (to: string) => {
    await refresh();
    navigate(to, { replace: true });
  };
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [studioName, setStudioName] = useState("");
  const [timezone, setTimezone] = useState(browserTimezone());
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const zones = useMemo(() => allTimezones(), []);
  const strength = score(password);

  const { busy, error, fieldErrors, submit, setFieldErrors } = useSubmit(() =>
    api("/setup", { body: { studioName, timezone, ownerName, email, password } }),
  );

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (!studioName.trim()) return setFieldErrors({ studioName: "Enter your studio's name." });
    setFieldErrors({});
    setStep(2);
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 10) return setFieldErrors({ password: "Use at least 10 characters." });
    if ((await submit()) === undefined) return;
    setStep(3);
  };

  return (
    <AuthLayout headline={step === 3 ? "You're all set." : "Let's set up your studio."} body="This takes about a minute. You can change everything later in Settings.">
      <div className="progress" aria-hidden="true">
        <span className="on" />
        <span className={step >= 2 ? "on" : ""} />
        <span className={step >= 3 ? "on" : ""} />
      </div>

      {step === 1 ? (
        <>
          <div>
            <div className="step-label">Step 1 of 2</div>
            <h2>Your studio</h2>
            <p className="lede">This name appears on booking pages, galleries, and emails your clients receive.</p>
          </div>
          <form onSubmit={next} noValidate>
            <Field label="Studio name" error={fieldErrors.studioName} hint="For example, Smith Portraits.">
              {(p) => <TextInput {...p} value={studioName} onChange={(e) => setStudioName(e.target.value)} autoComplete="organization" autoFocus maxLength={120} />}
            </Field>
            <Field label="Time zone" hint="Used for your calendar, booking times, and reminders.">
              {(p) => (
                <select {...p} className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {prettyTimezone(z)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Button type="submit" variant="primary" size="lg" block iconRight="arrowRight">
              Continue
            </Button>
          </form>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <div>
            <div className="step-label">Step 2 of 2</div>
            <h2>Your account</h2>
            <p className="lede">You'll be the studio owner. You can invite staff later.</p>
          </div>
          <form onSubmit={finish} noValidate>
            {error ? <Callout tone="bad">{error}</Callout> : null}
            <Field label="Your name" error={fieldErrors.ownerName}>
              {(p) => <TextInput {...p} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} autoComplete="name" autoFocus />}
            </Field>
            <Field label="Email" error={fieldErrors.email} hint="You'll sign in with this.">
              {(p) => <TextInput {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}
            </Field>
            <Field label="Password" error={fieldErrors.password} hint={password ? scoreLabel[strength] : "At least 10 characters. A short phrase is easy to remember."}>
              {(p) => (
                <>
                  <TextInput {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  <div className="pw-meter" data-score={strength} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                </>
              )}
            </Field>
            <div className="form-actions" style={{ justifyContent: "space-between" }}>
              <Button variant="ghost" icon="arrowLeft" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!ownerName || !email || !password}>
                Create studio
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <div className="done-mark">
            <Icon name="check" />
          </div>
          <div>
            <h2>{studioName} is ready</h2>
            <p className="lede">Next, put your studio online so clients can reach booking pages and galleries.</p>
          </div>
          <div className="next-list">
            <button type="button" className="next-item primary" onClick={() => void go("/studio/settings/internet")}>
              <span className="ic">
                <Icon name="globe" />
              </span>
              <span className="t">
                <b>Put your studio online</b>
                <span>Connect a Cloudflare Tunnel. About five minutes.</span>
              </span>
              <Icon name="arrowRight" />
            </button>
            <button type="button" className="next-item" onClick={() => void go("/studio")}>
              <span className="ic">
                <Icon name="home" />
              </span>
              <span className="t">
                <b>Go to your dashboard</b>
                <span>You can do this later from Settings.</span>
              </span>
              <Icon name="arrowRight" />
            </button>
          </div>
        </>
      ) : null}
    </AuthLayout>
  );
}
