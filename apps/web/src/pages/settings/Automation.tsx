import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Callout, CopyValue, Field, Panel, StatusChip, useToast } from "@openportrait/ui";
import { api, type AutomationOwner, type AutomationStatus } from "../../lib/api.js";

const OWNER_LABEL: Record<AutomationOwner, string> = { "built-in": "Built-in", ai: "Your AI", off: "Off" };
const SCHEDULE_PROMPT = "Every morning, call studio_get_work_queue for my OpenPortrait studio. For each item, look up the details with the other tools, then do what is needed: add notes, move leads, update shoots, or draft messages. Anything that reaches a client will wait for my approval. Then tell me what you handled.";

const ago = (ms: number | null) => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

export function AutomationSettingsPage() {
  const toast = useToast();
  const [s, setS] = useState<AutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await api<AutomationStatus>("/automation"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load automation settings.");
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const save = async (body: object, message: string) => {
    setBusy(true);
    try {
      setS(await api<AutomationStatus>("/automation", { method: "PUT", body }));
      toast(message);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't save.", "bad");
    } finally {
      setBusy(false);
    }
  };

  if (error && !s) return <Callout tone="bad" title="Couldn't load automation settings">{error}</Callout>;
  if (!s) return <div className="boot" aria-busy="true" aria-label="Loading" />;

  const aiOwns = s.automations.some((a) => a.owner === "ai");
  return (
    <>
      <Panel title="Who runs the routine work?" description="Reminders, follow-ups and similar decisions. Booking confirmations, receipts, calendar sync, backups and photo processing always run on their own.">
        <fieldset className="choice-set">
          <legend className="sr-only">Automation mode</legend>
          <div className="choice-grid two">
            {(
              [
                ["built-in", "Built-in schedulers", "OpenPortrait applies your rules by itself. Your AI only acts when you ask it to."],
                ["ai", "AI-controlled", "Your connected AI decides. It reads a work queue and acts with its tools. Anything that reaches a client still needs your OK."],
              ] as const
            ).map(([id, title, text]) => (
              <label key={id} className={`choice ${s.mode === id ? "on" : ""}`}>
                <input type="radio" name="mode" checked={s.mode === id} disabled={busy} onChange={() => save({ mode: id }, id === "ai" ? "AI-controlled mode is on" : "Built-in schedulers are on")} />
                <b>{title}</b>
                <span>{text}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {s.mode === "ai" && !s.aiAccessEnabled ? (
          <Callout tone="warn" title="Your AI isn't connected yet" action={<Link className="btn sm" to="../ai">Connect your AI</Link>}>
            Nothing will be handled until an assistant connects.
          </Callout>
        ) : null}
        {s.stale ? (
          <Callout tone="warn" title="Your AI hasn't checked in">
            {s.queueSize} {s.queueSize === 1 ? "item is" : "items are"} waiting, and your assistant last checked {ago(s.lastCheckinAt)}. Nothing happens on its own in the meantime. Make sure it has a daily schedule (below), or switch an automation back to Built-in.
          </Callout>
        ) : null}
      </Panel>

      <Panel title="Automations" description="Each one follows the setting above unless you choose differently. You can run most of the studio on your AI and keep any one routine built-in.">
        <ul className="auto-list">
          {s.automations.map((a) => (
            <li key={a.id}>
              <div className="auto-text">
                <b>{a.title}</b>
                <span>{a.description}</span>
                {a.owner === "built-in" && a.reminders ? <StatusChip tone="info">{`${a.reminders} on your dashboard`}</StatusChip> : null}
                {a.owner === "ai" ? <StatusChip tone={a.waiting ? "info" : "ok"}>{a.waiting ? `${a.waiting} waiting for your AI` : "Nothing waiting"}</StatusChip> : null}
              </div>
              <Field label="Handled by" className="auto-select">
                {(p) => (
                  <select {...p} className="input" value={a.overridden ? a.owner : "follow"} disabled={busy} onChange={(e) => save({ overrides: { [a.id]: e.target.value === "follow" ? null : e.target.value } }, "Saved")}>
                    <option value="follow">Follow the setting ({OWNER_LABEL[s.mode]})</option>
                    <option value="built-in">Built-in</option>
                    <option value="ai">Your AI</option>
                    <option value="off">Off</option>
                  </select>
                )}
              </Field>
            </li>
          ))}
        </ul>
        <p className="hint">Built-in reminders and follow-up messages switch on as email and booking features ship. Until then, the work queue is where these routines show up.</p>
      </Panel>

      {aiOwns || s.mode === "ai" ? (
        <Panel title="Put your assistant on a schedule" description="An AI only acts when something calls it. Schedule this in your assistant (for example a daily scheduled task in Claude) so it checks the queue.">
          <CopyValue value={SCHEDULE_PROMPT} label="schedule prompt" />
          <div className="auto-facts">
            <span>
              Last check-in: <b>{ago(s.lastCheckinAt)}</b>
            </span>
            <span>
              Waiting for your OK: <b>{s.pendingApprovals}</b> {s.pendingApprovals ? <Link to="/studio/approvals">Review</Link> : null}
            </span>
          </div>
          <Field label="Warn me if it hasn't checked in for" hint="This only shows a warning. Nothing starts running on its own.">
            {(p) => (
              <select {...p} className="input" style={{ maxWidth: 220 }} value={s.windowHours} disabled={busy} onChange={(e) => save({ windowHours: Number(e.target.value) }, "Saved")}>
                {[6, 12, 24, 48, 72].map((h) => (
                  <option key={h} value={h}>
                    {h} hours
                  </option>
                ))}
              </select>
            )}
          </Field>
        </Panel>
      ) : null}
    </>
  );
}
