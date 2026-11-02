import { Field, TextArea, TextInput } from "@openportrait/ui";
import type { AnswerValue, QuestionField } from "../lib/questionnaires.js";

/** One question as a client sees it. Used on the public form and the builder's preview. */
export function QuestionControl({ field, value, onChange, error, disabled }: { field: QuestionField; value: AnswerValue | undefined; onChange: (v: AnswerValue | undefined) => void; error?: string | null; disabled?: boolean }) {
  const label = (
    <>
      {field.label}
      {field.required ? <span className="req" aria-label="required"> *</span> : null}
    </>
  );
  const str = typeof value === "string" ? value : "";

  if (field.type === "heading") return <h2 className="q-heading">{field.label}</h2>;

  if (field.type === "text") return <Field label={label} hint={field.help} error={error}>{(p) => <TextInput {...p} disabled={disabled} maxLength={500} value={str} onChange={(e) => onChange(e.target.value)} />}</Field>;
  if (field.type === "textarea") return <Field label={label} hint={field.help} error={error}>{(p) => <TextArea {...p} disabled={disabled} rows={4} maxLength={8000} value={str} onChange={(e) => onChange(e.target.value)} />}</Field>;
  if (field.type === "number") return <Field label={label} hint={field.help} error={error}>{(p) => <TextInput {...p} disabled={disabled} inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value)} />}</Field>;
  if (field.type === "date") return <Field label={label} hint={field.help} error={error}>{(p) => <TextInput {...p} disabled={disabled} type="date" value={str} onChange={(e) => onChange(e.target.value)} />}</Field>;

  // Choices are a group of controls, so they get a fieldset and legend rather than a single label.
  const choices = (
    <fieldset className="q-group" disabled={disabled} aria-invalid={error ? true : undefined}>
      <legend>{label}</legend>
      {field.help ? <span className="hint">{field.help}</span> : null}
      {field.type === "yesno" ? (
        <div className="seg" role="radiogroup" aria-label={field.label}>
          {[true, false].map((yes) => (
            <button key={String(yes)} type="button" role="radio" aria-checked={value === yes} className={value === yes ? "on" : ""} onClick={() => onChange(value === yes && !field.required ? undefined : yes)}>
              {yes ? "Yes" : "No"}
            </button>
          ))}
        </div>
      ) : field.type === "select" ? (
        <div className="q-options">
          {(field.options ?? []).map((o) => (
            <label key={o} className={`q-option${value === o ? " on" : ""}`}>
              <input type="radio" name={field.id} checked={value === o} onChange={() => onChange(o)} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="q-options">
          {(field.options ?? []).map((o) => {
            const list = Array.isArray(value) ? value : [];
            const on = list.includes(o);
            return (
              <label key={o} className={`q-option${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => onChange(on ? list.filter((x) => x !== o) : [...list, o])} />
                <span>{o}</span>
              </label>
            );
          })}
        </div>
      )}
      {error ? <span className="error-text">{error}</span> : null}
    </fieldset>
  );
  return choices;
}
