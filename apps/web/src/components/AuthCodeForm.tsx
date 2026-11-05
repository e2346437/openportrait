import { useCallback, useEffect, useState, type FormEvent } from "react";

const QUOTE = "The needs of the many outweigh the needs of the few. Or the one.".split(" ");

/** Easter egg: a faint glyph beside the code. Hover, focus or tap it for a short starfield clip. */
function Egg() {
  const [open, setOpen] = useState(false);
  return (
    <span className="egg" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="egg-glyph" aria-label="A small surprise" aria-expanded={open} onClick={() => setOpen(!open)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        🖖
      </button>
      {open ? (
        <span className="egg-clip" role="img" aria-label="The needs of the many outweigh the needs of the few. Or the one.">
          <i className="stars s1" />
          <i className="stars s2" />
          <span className="egg-quote" aria-hidden="true">
            {QUOTE.map((w, i) => (
              <span key={i} style={{ animationDelay: `${0.5 + i * 0.28}s` }}>{w} </span>
            ))}
          </span>
        </span>
      ) : null}
    </span>
  );
}
import { Button, Callout, Field, TextInput } from "@openportrait/ui";
import { api, type AiStatus } from "../lib/api.js";
import { useSubmit } from "../lib/useForm.js";

/**
 * Picks the owner's authorization code: a suggested "number + two words" they can shuffle or replace.
 * Used in onboarding and in Settings > Connect your AI. Changing an existing code asks for the password.
 */
export function AuthCodeForm({ replacing, onSaved, onSkip }: { replacing?: boolean; onSaved: (s: AiStatus) => void; onSkip?: () => void }) {
  const [code, setCode] = useState("");
  const [own, setOwn] = useState(false);
  const [password, setPassword] = useState("");

  const shuffle = useCallback(async () => {
    try {
      setCode((await api<{ code: string }>("/ai/auth-code/suggest")).code);
    } catch {
      setCode("");
    }
  }, []);
  useEffect(() => void shuffle(), [shuffle]);

  const { busy, error, fieldErrors, submit } = useSubmit(async () => {
    const s = await api<AiStatus>("/ai/auth-code", { method: "PUT", body: { code, password: replacing ? password : undefined } });
    onSaved(s);
    return s;
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <form onSubmit={onSubmit} noValidate className="authcode">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {own ? (
        <Field label="Your code" error={fieldErrors.code} hint="A number and two words is easiest to say aloud, like “47 Alpha Tango”. At least 6 characters.">
          {(p) => <TextInput {...p} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="words" spellCheck={false} maxLength={60} autoFocus />}
        </Field>
      ) : (
        <div className="code-plate" role="group" aria-label="Suggested authorization code">
          <output aria-live="polite">{code || "…"}</output>
          <Egg />
          <Button type="button" variant="ghost" size="sm" icon="refresh" onClick={() => void shuffle()} aria-label="Suggest a different code">
            Another
          </Button>
        </div>
      )}
      {replacing ? (
        <Field label="Your password" error={fieldErrors.password} hint="Needed to change an existing code.">
          {(p) => <TextInput {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
        </Field>
      ) : null}
      <div className="form-actions" style={{ justifyContent: "space-between" }}>
        <Button type="button" variant="ghost" onClick={() => setOwn(!own)}>
          {own ? "Use a suggestion" : "Choose my own"}
        </Button>
        <span style={{ display: "flex", gap: 8 }}>
          {onSkip ? (
            <Button type="button" variant="ghost" onClick={onSkip}>
              Not now
            </Button>
          ) : null}
          <Button type="submit" variant="primary" icon="key" loading={busy} disabled={!code.trim() || (replacing && !password)}>
            Save code
          </Button>
        </span>
      </div>
    </form>
  );
}
