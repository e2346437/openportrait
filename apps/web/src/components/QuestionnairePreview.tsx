import { useEffect, useRef, useState } from "react";
import { Button, Callout, Icon } from "@openportrait/ui";
import type { AnswerValue, Answers, QuestionField } from "../lib/questionnaires.js";
import { QuestionControl } from "./QuestionControl.js";
import { RichText } from "./RichText.js";

type Device = "phone" | "desktop";
const empty = (v: AnswerValue | undefined) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Switch between phone and desktop widths. */
export function DeviceSwitch({ value, onChange }: { value: Device; onChange: (d: Device) => void }) {
  return (
    <div className="seg" role="group" aria-label="Preview size">
      {(["phone", "desktop"] as const).map((d) => (
        <button key={d} type="button" aria-pressed={value === d} onClick={() => onChange(d)}>
          {d === "phone" ? "Phone" : "Desktop"}
        </button>
      ))}
    </div>
  );
}

/**
 * A questionnaire the way the client sees it, drawn by the same question controls as the public page. Answers are
 * kept only in this component and nothing is ever sent. "Send my answers" shows the same "please answer" prompts a
 * client would get, so required questions can be checked too.
 */
export function QuestionnairePreview({ studio, title, intro, fields }: { studio: string; title: string; intro: string; fields: QuestionField[] }) {
  const [device, setDevice] = useState<Device>("phone");
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  // Questions removed or retyped in the editor must not leave stale answers behind.
  const ids = fields.map((f) => `${f.id}:${f.type}`).join("|");
  useEffect(() => {
    setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([id]) => fields.some((f) => f.id === id))));
    setErrors({});
    setSent(false);
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (id: string) => (v: AnswerValue | undefined) => {
    setAnswers((a) => {
      const next = { ...a };
      if (empty(v)) delete next[id];
      else next[id] = v as AnswerValue;
      return next;
    });
    setErrors((e) => (e[id] ? { ...e, [id]: "" } : e));
    setSent(false);
  };

  const press = (e: React.FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    for (const f of fields) if (f.required && f.type !== "heading" && empty(answers[f.id])) missing[f.id] = "Please answer this one.";
    setErrors(missing);
    setSent(Object.keys(missing).length === 0);
    if (Object.keys(missing).length) form.current?.querySelector<HTMLElement>("[aria-invalid]")?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <div className="qp">
      <div className="qp-bar">
        <span className="qp-badge">
          <Icon name="eye" width={14} height={14} /> Preview. Nothing is saved or sent.
        </span>
        <DeviceSwitch value={device} onChange={setDevice} />
      </div>
      <div className={`qp-frame ${device}`}>
        <div className="qp-page">
          <div className="pub-card narrow qp-card">
            {studio ? <p className="pub-studio">{studio}</p> : null}
            <h1 className="pub-title">{title.trim() || "Untitled questionnaire"}</h1>
            {intro.trim() ? <RichText className="pub-lead" text={intro} /> : null}
            {fields.length === 0 ? (
              <p className="hint">No questions yet. Add one in the editor and it shows up here.</p>
            ) : (
              <form ref={form} onSubmit={press} noValidate className="q-form">
                {fields.map((f) => (
                  <QuestionControl key={f.id} field={{ ...f, label: f.label || (f.type === "heading" ? "Section title" : "Your question") }} value={answers[f.id]} onChange={set(f.id)} error={errors[f.id]} />
                ))}
                {Object.values(errors).some(Boolean) ? <Callout tone="bad">A few questions still need an answer. They're marked above.</Callout> : null}
                {sent ? <Callout tone="ok">This is where a client sees “Thank you”. Nothing was sent.</Callout> : null}
                <div className="q-submit">
                  <Button variant="primary" size="lg" type="submit" icon="send">
                    Send my answers
                  </Button>
                  <p className="hint">
                    <Icon name="lock" width={14} height={14} /> Only {studio || "the studio"} sees your answers.
                  </p>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
