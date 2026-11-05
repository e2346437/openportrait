import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button, Callout, Field, TextInput } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { useSession } from "../lib/session.js";
import { useSubmit } from "../lib/useForm.js";
import { AuthLayout } from "./AuthLayout.js";

export function LoginPage() {
  const { refresh, me } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { busy, error, fieldErrors, submit } = useSubmit(async () => {
    if (challenge) return api<{ mfaRequired?: boolean }>("/auth/login/mfa", { body: { challenge, code } });
    const res = await api<{ mfaRequired?: boolean; challenge?: string }>("/auth/login", { body: { email, password } });
    if (res.mfaRequired && res.challenge) setChallenge(res.challenge);
    return res;
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await submit();
    if (res === undefined) return;
    if (res.mfaRequired) return;
    await refresh();
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && from.startsWith("/studio") ? from : "/studio", { replace: true });
  };

  return (
    <AuthLayout
      headline={me?.studio.name || "Welcome back"}
      body={me?.studio.name ? "Clients, bookings and galleries, on your own server." : undefined}
      photo={me?.studio.signInPhoto}
      credit={me?.studio.name ? `A photo from ${me.studio.name}` : undefined}
    >
      <div>
        <h2>{challenge ? "Enter your code." : "Welcome back."}</h2>
        <p className="lede">{challenge ? "Open your authenticator app and enter the 6-digit code, or use a recovery code." : "Sign in with your studio account."}</p>
      </div>
      <form onSubmit={onSubmit} noValidate>
        {error ? <Callout tone="bad">{error}</Callout> : null}
        {challenge ? (
          <>
            <Field label="Code" error={fieldErrors.code}>
              {(p) => <TextInput {...p} inputMode="text" autoComplete="one-time-code" className="mfa-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />}
            </Field>
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!code.trim()}>
              Verify
            </Button>
            <Button
              variant="ghost"
              block
              onClick={() => {
                setChallenge(null);
                setCode("");
                setPassword("");
              }}
            >
              Back
            </Button>
          </>
        ) : (
          <>
            <Field label="Email" error={fieldErrors.email}>
              {(p) => <TextInput {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}
            </Field>
            <Field label="Password" error={fieldErrors.password}>
              {(p) => <TextInput {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
            </Field>
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!email || !password}>
              Sign in
            </Button>
          </>
        )}
      </form>
      <p className="hint">
        Forgot your password? Run <code className="mono">docker exec openportrait openportrait reset-password you@example.com</code> on the server to get a temporary one.
      </p>
    </AuthLayout>
  );
}
