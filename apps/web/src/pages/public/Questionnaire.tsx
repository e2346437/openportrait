import { useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Button, Callout, Icon, Spinner } from "@openportrait/ui";
import { QuestionControl } from "../../components/QuestionControl.js";
import { publicApi } from "../../lib/api.js";
import { answerText, type AnswerValue, type Answers, type QuestionField } from "../../lib/questionnaires.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { PublicMessage, PublicShell } from "./PublicShell.js";

interface View {
  studioName: string;
  title: string;
  intro: string | null;
  fields: QuestionField[];
  status: "open" | "submitted";
  answers: Answers | null;
}

const empty = (v: AnswerValue | undefined) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** The page a client opens from their email to answer a questionnaire. */
export function QuestionnairePage() {
  const { token = "" } = useParams();
  const { data, error, loading } = useLoad<View>(`/questionnaire/${encodeURIComponent(token)}`, { api: publicApi });
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const { busy, error: err, submit } = useSubmit(() => publicApi("/questionnaire/" + encodeURIComponent(token), { body: { answers } }));

  if (loading && !data) return <PublicShell narrow><Spinner label="Loading" /></PublicShell>;
  if (error || !data) return <PublicMessage title="This link isn't working">It may have been mistyped or replaced. Reply to the email you were sent and we'll get you a new one.</PublicMessage>;

  if (done || data.status === "submitted") {
    const read = data.answers;
    return (
      <PublicShell studio={data.studioName}>
        <h1 className="pub-title">{done ? "Thank you" : "Already sent"}</h1>
        <p className="pub-lead" role="status">
          {done ? "Your answers are in. You don't need to do anything else." : "Your answers were sent. If you need to change something, reply to the email and ask for a new link."}
        </p>
        {read && !done ? <AnswerSummary fields={data.fields} answers={read} /> : null}
      </PublicShell>
    );
  }

  const set = (id: string) => (v: AnswerValue | undefined) => {
    setAnswers((a) => {
      const next = { ...a };
      if (empty(v)) delete next[id];
      else next[id] = v as AnswerValue;
      return next;
    });
    setErrors((e) => (e[id] ? { ...e, [id]: "" } : e));
  };

  const go = async (e: FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    for (const f of data.fields) if (f.required && f.type !== "heading" && empty(answers[f.id])) missing[f.id] = "Please answer this one.";
    setErrors(missing);
    const first = data.fields.find((f) => missing[f.id]);
    if (first) {
      formRef.current?.querySelector<HTMLElement>("[aria-invalid]")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if ((await submit()) !== undefined) {
      setDone(true);
      window.scrollTo({ top: 0 });
    }
  };

  return (
    <PublicShell studio={data.studioName}>
      <h1 className="pub-title">{data.title}</h1>
      {data.intro ? <p className="pub-lead">{data.intro}</p> : null}
      <form ref={formRef} onSubmit={go} noValidate className="q-form">
        {err ? <Callout tone="bad">{err}</Callout> : null}
        {data.fields.map((f) => (
          <QuestionControl key={f.id} field={f} value={answers[f.id]} onChange={set(f.id)} error={errors[f.id]} />
        ))}
        {Object.values(errors).some(Boolean) ? <Callout tone="bad">A few questions still need an answer. They're marked above.</Callout> : null}
        <div className="q-submit">
          <Button variant="primary" size="lg" type="submit" loading={busy} icon="send">
            Send my answers
          </Button>
          <p className="hint">
            <Icon name="lock" width={14} height={14} /> Only {data.studioName || "the studio"} sees your answers.
          </p>
        </div>
      </form>
    </PublicShell>
  );
}

function AnswerSummary({ fields, answers }: { fields: QuestionField[]; answers: Answers }) {
  return (
    <dl className="q-answers">
      {fields.filter((f) => f.type !== "heading").map((f) => (
        <div key={f.id}>
          <dt>{f.label}</dt>
          <dd>{answerText(f, answers[f.id]) || <span className="muted">No answer</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
