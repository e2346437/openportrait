import { useState } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Panel, Spinner, StatusChip, copyText, useToast, type Tone } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { answerText, type SentQuestionnaire, type Template } from "../../lib/questionnaires.js";
import { useSession } from "../../lib/session.js";
import { formatDate, ms } from "../../lib/time.js";
import { useLoad } from "../../lib/useLoad.js";
import { EmailOffCallout } from "../../components/EmailOffCallout.js";

function state(q: SentQuestionnaire): { label: string; tone: Tone } {
  if (q.status === "submitted") return { label: "Answered", tone: "ok" };
  if (q.status === "draft") return { label: "Draft", tone: "neutral" };
  return q.viewedAt ? { label: "Opened, not answered", tone: "warn" } : { label: "Sent", tone: "info" };
}

/** The questionnaires on one shoot: send them, follow up, and read the answers. */
export function ShootQuestionnaires({ shootId, clientEmail }: { shootId: string; clientEmail: string | null }) {
  const toast = useToast();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const list = useLoad<{ items: SentQuestionnaire[] }>(`/shoots/${shootId}/questionnaires`);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const when = (t: number | null) => (t ? formatDate(ms(t), tz, { month: "short", day: "numeric" }) : "");

  const act = async (id: string, what: "send" | "reopen" | "delete") => {
    setBusy(id + what);
    try {
      if (what === "delete") await api(`/questionnaires/${id}`, { method: "DELETE" });
      else {
        const r = await api<{ emailed?: boolean }>(`/questionnaires/${id}/${what}`, { method: "POST" });
        toast(what === "reopen" ? "Reopened. The client can answer again." : r.emailed ? "Sent to the client" : "Marked as sent, but no email went out. Check your email settings.", what === "send" && !r.emailed ? "bad" : "ok");
      }
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Questionnaires" description="Forms for the client to fill in. Their answers are saved here." actions={<Button size="sm" icon="plus" onClick={() => setAdding(true)}>Add</Button>} flush>
      {list.error ? <div className="pad"><Callout tone="bad">{list.error}</Callout></div> : null}
      <div className="pad" style={{ paddingBottom: 0 }}>
        <EmailOffCallout>Questionnaires can't be sent yet. Automatic ones wait as drafts until email is set up.</EmailOffCallout>
      </div>
      {list.loading && !list.data ? <div className="pad"><Spinner label="Loading" /></div> : null}
      {list.data && items.length === 0 ? (
        <EmptyState icon="note" title="Nothing sent yet" action={<Button icon="plus" onClick={() => setAdding(true)}>Add a questionnaire</Button>}>
          Ask the client for the details you need, like timelines, family names or the look they want.
        </EmptyState>
      ) : (
        <ul className="q-sent">
          {items.map((q) => {
            const s = state(q);
            const expanded = open === q.id;
            return (
              <li key={q.id}>
                <div className="q-sent-row">
                  <span className="cat-main">
                    <b>{q.title}</b>
                    <small>
                      {q.status === "draft" ? "Not sent yet" : q.status === "submitted" ? `Answered ${when(q.submittedAt)} · ${q.answered} of ${q.questions}` : `Sent ${when(q.sentAt)}`}
                      {q.origin === "auto" && q.status !== "draft" ? " · sent automatically" : ""}
                    </small>
                  </span>
                  <StatusChip tone={s.tone}>{s.label}</StatusChip>
                </div>
                {q.status === "draft" && !clientEmail ? <p className="hint">Add an email address for the client, then send it.</p> : null}
                <div className="q-sent-actions">
                  {q.status === "submitted" ? (
                    <>
                      <Button size="sm" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : q.id)}>{expanded ? "Hide answers" : "View answers"}</Button>
                      <Button size="sm" variant="ghost" loading={busy === q.id + "reopen"} onClick={() => act(q.id, "reopen")}>Ask again</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant={q.status === "draft" ? "primary" : "default"} icon="send" disabled={!clientEmail} loading={busy === q.id + "send"} onClick={() => act(q.id, "send")}>{q.status === "draft" ? "Send" : "Remind"}</Button>
                      <Button size="sm" variant="ghost" icon="copy" onClick={() => void copyText(q.link).then((ok) => toast(ok ? "Link copied" : "Couldn't copy the link", ok ? "ok" : "bad"))}>Copy link</Button>
                      <Button size="sm" variant="ghost" loading={busy === q.id + "delete"} onClick={() => act(q.id, "delete")}>Remove</Button>
                    </>
                  )}
                </div>
                {expanded && q.answers ? (
                  <dl className="q-answers">
                    {q.fields.filter((f) => f.type !== "heading").map((f) => (
                      <div key={f.id}>
                        <dt>{f.label}</dt>
                        <dd>{answerText(f, q.answers![f.id]) || <span className="muted">No answer</span>}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <AddDialog open={adding} shootId={shootId} canEmail={!!clientEmail} onClose={() => setAdding(false)} onDone={(sent) => { setAdding(false); list.reload(); toast(sent ? "Sent to the client" : "Saved as a draft"); }} />
    </Panel>
  );
}

function AddDialog({ open, shootId, canEmail, onClose, onDone }: { open: boolean; shootId: string; canEmail: boolean; onClose: () => void; onDone: (sent: boolean) => void }) {
  const t = useLoad<{ items: Template[] }>(open ? "/questionnaire-templates" : null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = t.data?.items ?? [];
  const chosen = pick || items[0]?.id || "";
  const go = async (send: boolean) => {
    setBusy(send ? "send" : "draft");
    setError(null);
    try {
      await api(`/shoots/${shootId}/questionnaires`, { body: { templateId: chosen, send } });
      onDone(send);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a questionnaire"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!chosen} loading={busy === "draft"} onClick={() => go(false)}>Save as draft</Button>
          <Button variant="primary" icon="send" disabled={!chosen || !canEmail} loading={busy === "send"} onClick={() => go(true)}>Send to client</Button>
        </>
      }
    >
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {!t.data ? <Spinner label="Loading" /> : items.length === 0 ? (
        <Callout tone="info" title="No questionnaires yet">Build one in Settings, then come back here to send it.</Callout>
      ) : (
        <div className="stack">
          <Field label="Which questionnaire?">
            {(p) => (
              <select {...p} className="input" value={chosen} onChange={(e) => setPick(e.target.value)}>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.questions} questions)</option>)}
              </select>
            )}
          </Field>
          {!canEmail ? <Callout tone="warn">This client has no email address, so you can save a draft and copy its link, but not email it.</Callout> : null}
        </div>
      )}
    </Dialog>
  );
}
