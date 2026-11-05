import { useEffect, useState } from "react";
import { Callout, Field, Spinner } from "@openportrait/ui";

export type ProofMode = "light" | "balanced" | "strong";
export type ProofApply = "locked" | "always" | "off";
export interface ProofPolicy {
  mode: ProofMode;
  apply: ProofApply;
  maxLongEdge: number | null;
}

export const PROOF_MODES: Array<{ id: ProofMode; title: string; edge: number; body: string }> = [
  { id: "light", title: "Light", edge: 1800, body: "Subtle marks, crisp previews. For portfolios and low-risk galleries." },
  { id: "balanced", title: "Balanced", edge: 1400, body: "Textured marks that vary across the photo. Good for client selection and unpaid proofs." },
  { id: "strong", title: "Strong", edge: 1000, body: "Denser marks and smaller previews. For high-value shoots where a clean copy matters most." },
];
export const PROOF_APPLY: Array<{ id: ProofApply; title: string; body: string }> = [
  { id: "locked", title: "While downloads are locked", body: "Previews are protected until the gallery is paid for, then become clean. The long-standing behavior." },
  { id: "always", title: "Always", body: "Previews stay protected even after payment or when downloads are open. Downloads themselves are never marked." },
  { id: "off", title: "Never", body: "Previews are never marked. Anyone with the link can save a full-size preview." },
];
export const edgeFor = (p: ProofPolicy) => p.maxLongEdge ?? PROOF_MODES.find((m) => m.id === p.mode)!.edge;
export const proofSummary = (p: ProofPolicy) => `${PROOF_MODES.find((m) => m.id === p.mode)!.title}, ${PROOF_APPLY.find((a) => a.id === p.apply)!.title.toLowerCase()}`;

/** Before and after, drawn by the server with the code that protects real previews. It does not simulate an attacker. */
function Preview({ policy, photoId }: { policy: ProofPolicy; photoId?: string }) {
  const q = new URLSearchParams({ mode: policy.mode });
  if (policy.maxLongEdge) q.set("maxLongEdge", String(policy.maxLongEdge));
  if (photoId) q.set("photoId", photoId);
  const key = q.toString();
  const [shown, setShown] = useState(key);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => {
    setState("loading");
    const t = setTimeout(() => setShown(key), 250);
    return () => clearTimeout(t);
  }, [key]);
  const cleanQ = new URLSearchParams(shown);
  cleanQ.set("clean", "1");
  return (
    <div className="proof-preview">
      <figure>
        <div className="wm-photo"><img src={`/api/studio/proofing/preview?${cleanQ}`} alt="The photo as you shot it" /></div>
        <figcaption>Original</figcaption>
      </figure>
      <figure aria-busy={state === "loading"}>
        <div className="wm-photo">
          <img src={`/api/studio/proofing/preview?${shown}`} alt="The same photo as a client sees it with protection on" onLoad={() => setState("ok")} onError={() => setState("error")} />
          {state === "loading" ? <span className="wm-busy"><Spinner label="Updating preview" /></span> : null}
          {state === "error" ? <span className="wm-busy hint">Preview unavailable</span> : null}
        </div>
        <figcaption>Client sees ({edgeFor(policy)} px long edge)</figcaption>
      </figure>
    </div>
  );
}

/** The three presets, when to apply them, an optional size, and a live before/after. Shared by Settings and each gallery. */
export function ProofingControls({ value, onChange, disabled, photoId, idPrefix }: { value: ProofPolicy; onChange: (patch: Partial<ProofPolicy>) => void; disabled?: boolean; photoId?: string; idPrefix: string }) {
  const custom = value.maxLongEdge !== null;
  const presetEdge = PROOF_MODES.find((m) => m.id === value.mode)!.edge;
  return (
    <div className="stack">
      <fieldset className="opts" disabled={disabled}>
        <legend className="label">Strength</legend>
        {PROOF_MODES.map((m) => (
          <label key={m.id} className="opt">
            <input type="radio" name={`${idPrefix}-mode`} checked={value.mode === m.id} onChange={() => onChange({ mode: m.id })} />
            <span className="t">
              <b>{m.title} <span className="muted">· {m.edge} px</span></b>
              <span>{m.body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="opts" disabled={disabled}>
        <legend className="label">Protect previews</legend>
        {PROOF_APPLY.map((a) => (
          <label key={a.id} className="opt">
            <input type="radio" name={`${idPrefix}-apply`} checked={value.apply === a.id} onChange={() => onChange({ apply: a.id })} />
            <span className="t">
              <b>{a.title}</b>
              <span>{a.body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {value.apply === "off" ? <Callout tone="warn">With protection off, a visitor can save a clean 2048 px copy of every photo, even while downloads are locked.</Callout> : null}
      <Field label={custom ? `Preview size: ${value.maxLongEdge} px` : `Preview size: ${presetEdge} px (from ${PROOF_MODES.find((m) => m.id === value.mode)!.title})`} hint="Smaller previews give a copier less to work with but look softer on high-density screens. Check on your phone.">
        {(p) => (
          <div className="proof-size">
            <input {...p} type="range" className="range" min={600} max={2048} step={50} disabled={disabled} value={value.maxLongEdge ?? presetEdge} onChange={(e) => onChange({ maxLongEdge: Number(e.target.value) })} />
            {custom ? <button type="button" className="btn sm" disabled={disabled} onClick={() => onChange({ maxLongEdge: null })}>Use the preset's size</button> : null}
          </div>
        )}
      </Field>
      <Preview policy={value} photoId={photoId} />
      <p className="hint">Protected Proofing deters casual copying and limits the quality of unauthorized reproductions. It cannot prevent screenshots or all AI recreation, so it is no substitute for locking downloads.</p>
    </div>
  );
}
