import { useCallback, useEffect, useState } from "react";
import { Button, Callout, EmptyState, Icon, PageHeader, Panel, StatusChip, useToast } from "@openportrait/ui";
import { api, type AiApproval } from "../lib/api.js";

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

const TOOL_NAMES: Record<string, string> = {};
const prettyTool = (t: string) => TOOL_NAMES[t] ?? t.replace(/_/g, " ");

function Card({ a, busy, onDecide }: { a: AiApproval; busy: boolean; onDecide: (approve: boolean) => void }) {
  return (
    <li className="approval">
      <div className="approval-main">
        <div className="approval-head">
          <StatusChip tone={a.tier === "money" ? "warn" : "info"}>{a.tier === "money" ? "Money" : "Reaches a client"}</StatusChip>
          <span className="hint">
            {a.connection} · {ago(a.createdAt)}
          </span>
        </div>
        <p className="approval-summary">{a.summary}</p>
        <details className="approval-details">
          <summary>Details</summary>
          <pre className="snippet" tabIndex={0}>{JSON.stringify(a.args, null, 2)}</pre>
        </details>
      </div>
      <div className="approval-actions">
        <Button variant="primary" icon="check" loading={busy} onClick={() => onDecide(true)}>
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onDecide(false)}>
          Decline
        </Button>
      </div>
    </li>
  );
}

export function ApprovalsPage() {
  const toast = useToast();
  const [items, setItems] = useState<AiApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: AiApproval[] }>("/ai/approvals")).items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load approvals.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  const decide = async (a: AiApproval, approve: boolean) => {
    setBusy(a.id);
    try {
      const r = await api<AiApproval>(`/ai/approvals/${a.id}/${approve ? "approve" : "decline"}`, { method: "POST" });
      toast(approve ? (r.status === "failed" ? "It was approved but the action failed" : "Approved and done") : "Declined", r.status === "failed" ? "bad" : "ok");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "bad");
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (error && !items) return <Callout tone="bad" title="Couldn't load approvals">{error}</Callout>;
  const pending = items?.filter((i) => i.status === "pending") ?? [];
  const history = items?.filter((i) => i.status !== "pending").slice(0, 20) ?? [];

  return (
    <>
      <PageHeader title="Approvals" description="Things your AI assistant wants to do that reach a client or involve money. Nothing happens until you say so." />
      <Panel title={pending.length ? `Waiting for you (${pending.length})` : "Waiting for you"}>
        {!items ? (
          <p className="hint">Loading…</p>
        ) : pending.length === 0 ? (
          <EmptyState icon="shield" title="You're all caught up">Requests from your assistant appear here and expire after 7 days.</EmptyState>
        ) : (
          <ul className="approvals">
            {pending.map((a) => (
              <Card key={a.id} a={a} busy={busy === a.id} onDecide={(ok) => decide(a, ok)} />
            ))}
          </ul>
        )}
      </Panel>
      {history.length ? (
        <Panel title="Recent decisions">
          <ul className="activity">
            {history.map((a) => (
              <li key={a.id}>
                <Icon name={a.status === "approved" ? "check" : a.status === "failed" ? "alert" : "x"} width={16} height={16} />
                <span>
                  {a.summary || prettyTool(a.tool)} <span className="hint">· {a.status}</span>
                </span>
                <time>{ago(a.decidedAt ?? a.createdAt)}</time>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}
