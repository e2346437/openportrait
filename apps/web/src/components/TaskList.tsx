import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Callout, EmptyState, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { useSession } from "../lib/session.js";
import { formatDate } from "../lib/time.js";
import { useLoad } from "../lib/useLoad.js";

export interface Task {
  id: string;
  shootId: string;
  title: string;
  dueDate: string | null;
  done: boolean;
  overdue: boolean;
  shoot?: { id: string; subject: string; type: string; contactName: string };
}

/** "2027-03-14" as a short date, without letting a time zone move it a day. */
export const dueLabel = (d: string, tz: string) => formatDate(Date.parse(`${d}T12:00:00Z`), "UTC", { month: "short", day: "numeric", year: new Date(`${d}T12:00:00Z`).getUTCFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/**
 * To-dos with a checkbox each. On a shoot it lists that shoot's tasks and lets you add more; with no shoot it lists
 * what's open across every shoot (or what's done), with a link to each shoot.
 */
export function TaskList({ shootId, status = "open" }: { shootId?: string; status?: "open" | "done" }) {
  const toast = useToast();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const url = shootId ? `/shoots/${shootId}/tasks` : `/tasks?status=${status}`;
  const { data, error, loading, setData, reload } = useLoad<{ items: Task[] }>(url);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const items = data?.items ?? [];

  const fail = (err: unknown) => toast(err instanceof Error ? err.message : "That didn't save.", "bad");
  const toggle = async (t: Task) => {
    // Tick it straight away; the server's answer replaces it, and a failure puts it back.
    setData({ items: items.map((x) => (x.id === t.id ? { ...x, done: !t.done } : x)) });
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: { done: !t.done } });
      await reload();
    } catch (err) {
      fail(err);
      await reload();
    }
  };
  const remove = async (t: Task) => {
    try {
      await api(`/tasks/${t.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      fail(err);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !shootId) return;
    setBusy(true);
    try {
      await api(`/shoots/${shootId}/tasks`, { body: { title, dueDate: due || null } });
      setTitle("");
      setDue("");
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-list">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {loading && !data ? <Spinner label="Loading tasks" /> : null}
      {data && items.length === 0 && !shootId ? (
        <EmptyState icon="check" title={status === "open" ? "Nothing to do" : "Nothing finished yet"}>
          {status === "open" ? "Tasks you add to a shoot, or that a shoot type starts with, show up here." : "Ticked-off tasks are kept here."}
        </EmptyState>
      ) : null}
      {items.length ? (
        <ul className="task-items">
          {items.map((t) => (
            <li key={t.id} className={t.done ? "done" : ""}>
              <label className="task-check">
                <input type="checkbox" checked={t.done} onChange={() => void toggle(t)} aria-label={`${t.done ? "Reopen" : "Finish"}: ${t.title}`} />
                <span className="task-body">
                  <b>{t.title}</b>
                  {t.shoot ? (
                    <small>
                      <Link to={`/studio/shoots/${t.shoot.id}`}>{t.shoot.subject}</Link> · {t.shoot.type}
                    </small>
                  ) : null}
                </span>
              </label>
              {t.dueDate ? <StatusChip tone={t.overdue ? "bad" : "neutral"}>{t.overdue ? "Overdue · " : ""}{dueLabel(t.dueDate, tz)}</StatusChip> : null}
              {shootId ? <Button size="sm" variant="ghost" className="icon danger" icon="trash" aria-label={`Delete ${t.title}`} onClick={() => void remove(t)} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {shootId ? (
        <form className="task-add" onSubmit={add}>
          <TextInput aria-label="New task" placeholder="Add a task, like “Cull and edit”" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <input type="date" className="input" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
          <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>Add</Button>
        </form>
      ) : null}
    </div>
  );
}
