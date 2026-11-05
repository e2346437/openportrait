import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import type { GroupDayChild } from "../../lib/types.js";
import type { TetherPhoto } from "../../lib/tether.js";

interface Mark {
  path: string;
  name: string;
  email: string | null;
  childId: string | null;
}
interface SortResult {
  people: Array<{ subject: string; frames: number }>;
  moved: number;
  leftOver: number;
}

/**
 * Group-day controls for the live view: a small pill showing who is being shot, a form to flag the current frame as a
 * name card (M), and a drawer (N) with the people so far and a button to sort the day. Renders nothing when no group
 * day was picked, so the plain live view is unchanged.
 */
export function DaySession({ day, shown, history, visible, onActivity }: { day: string; shown: TetherPhoto | null; history: TetherPhoto[]; visible: boolean; onActivity: () => void }) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [people, setPeople] = useState<GroupDayChild[]>([]);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"none" | "card" | "drawer">("none");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [childId, setChildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([api<{ marks: Mark[] }>(`/incoming/days/${day}/marks`), api<{ subject: string; children: GroupDayChild[] }>(`/shoots/${day}`)]);
      setMarks(m.marks);
      setPeople(d.children);
      setTitle(d.subject);
    } catch (e) {
      setNote({ tone: "bad", text: (e as Error).message });
    }
  }, [day]);
  useEffect(() => void load(), [load]);

  // Frames per person, counted along the order the photos arrived.
  const counted = useMemo(() => {
    const at = (p: string) => history.findIndex((h) => h.id === p);
    const sorted = marks.map((m) => ({ ...m, i: at(m.path) })).filter((m) => m.i >= 0).sort((a, b) => a.i - b.i);
    return sorted.map((m, k) => ({ ...m, frames: (sorted[k + 1]?.i ?? history.length) - m.i }));
  }, [marks, history]);
  const current = counted[counted.length - 1] ?? null;
  const unmarked = people.filter((p) => !marks.some((m) => m.childId === p.id));
  const suggestions = name.trim() ? unmarked.filter((p) => p.subject.toLowerCase().includes(name.trim().toLowerCase())).slice(0, 4) : [];

  const openCard = useCallback(() => {
    if (!shown) return;
    setNote(null);
    setMode("card");
    setName("");
    setEmail("");
    setChildId(null);
    onActivity();
    window.setTimeout(() => nameRef.current?.focus(), 30);
  }, [shown, onActivity]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) {
        if (e.key === "Escape") setMode("none");
        return;
      }
      if (e.key === "m" || e.key === "M") openCard();
      if (e.key === "n" || e.key === "N") {
        setMode((m) => (m === "drawer" ? "none" : "drawer"));
        onActivity();
      }
      if (e.key === "Escape") setMode("none");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCard, onActivity]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!shown || !name.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ marks: Mark[] }>(`/incoming/days/${day}/marks`, { method: "POST", body: { path: shown.id, name, email: email || null, childId } });
      setMarks(r.marks);
      setMode("none");
      setNote({ tone: "ok", text: `${name.trim()} started` });
      void load();
    } catch (err) {
      setNote({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const unmark = async (path: string) => {
    try {
      setMarks((await api<{ marks: Mark[] }>(`/incoming/days/${day}/marks?path=${encodeURIComponent(path)}`, { method: "DELETE" })).marks);
    } catch (err) {
      setNote({ tone: "bad", text: (err as Error).message });
    }
  };
  const finish = async () => {
    setBusy(true);
    try {
      const r = await api<SortResult>(`/incoming/days/${day}/apply`, { method: "POST" });
      setNote({ tone: "ok", text: `Sorted ${r.moved} photos into ${r.people.length} ${r.people.length === 1 ? "person" : "people"}${r.leftOver ? `. ${r.leftOver} stayed in Incoming.` : ""}` });
      setMode("none");
      await load();
    } catch (err) {
      setNote({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={`day-pill-wrap${visible || mode !== "none" ? "" : " calm"}`}>
        <button type="button" className="day-pill" aria-expanded={mode === "drawer"} aria-label="People on this day (N)" onClick={() => setMode((m) => (m === "drawer" ? "none" : "drawer"))}>
          <i className={current ? "on" : ""} aria-hidden />
          {current ? (
            <>
              <b>{current.name}</b>
              <span>
                {current.frames} {current.frames === 1 ? "frame" : "frames"}
              </span>
            </>
          ) : (
            <span>{title || "Group day"}: no one yet</span>
          )}
          <kbd>N</kbd>
        </button>
        <button type="button" className="day-pill alt" onClick={openCard} disabled={!shown} aria-label="Mark this frame as a name card (M)">
          <Icon name="user" /> Name card <kbd>M</kbd>
        </button>
      </div>

      {note ? (
        <div className={`day-note ${note.tone}`} role="status" onAnimationEnd={() => undefined}>
          {note.text}
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)}>
            <Icon name="x" />
          </button>
        </div>
      ) : null}

      {mode === "card" ? (
        <form className="day-sheet" onSubmit={save} aria-label="Name card for this frame">
          <h4>New person from this frame</h4>
          <input ref={nameRef} className="day-in" placeholder="Name as written" value={name} maxLength={120} autoComplete="off" onChange={(e) => { setName(e.target.value); setChildId(null); }} />
          {suggestions.length ? (
            <div className="day-sugg" role="listbox" aria-label="People already on the list">
              {suggestions.map((p) => (
                <button key={p.id} type="button" role="option" aria-selected={childId === p.id} onClick={() => { setName(p.subject); setEmail(p.email ?? ""); setChildId(p.id); }}>
                  {p.subject}
                  {p.email ? <small>{p.email}</small> : null}
                </button>
              ))}
            </div>
          ) : null}
          <input className="day-in" type="email" placeholder="Email (optional)" value={email} maxLength={200} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
          <div className="day-row">
            <button type="button" className="day-btn" onClick={() => setMode("none")}>
              Cancel <kbd>Esc</kbd>
            </button>
            <button type="submit" className="day-btn primary" disabled={busy || !name.trim()}>
              Start <kbd>Enter</kbd>
            </button>
          </div>
        </form>
      ) : null}

      {mode === "drawer" ? (
        <section className="day-sheet" aria-label="People on this day">
          <h4>
            {title} · {counted.length} {counted.length === 1 ? "person" : "people"} so far
          </h4>
          {counted.length === 0 ? <p className="day-empty">Take the first name card photo, then press M.</p> : null}
          <ul className="day-list">
            {counted.map((m) => (
              <li key={m.path}>
                <i className="on" aria-hidden />
                <span>{m.name}</span>
                <small>{m.frames} {m.frames === 1 ? "frame" : "frames"}</small>
                <button type="button" aria-label={`Remove the name card for ${m.name}`} onClick={() => void unmark(m.path)}>
                  <Icon name="x" />
                </button>
              </li>
            ))}
          </ul>
          {unmarked.length ? (
            <>
              <h4>Still to come</h4>
              <ul className="day-list">
                {unmarked.slice(0, 6).map((p) => (
                  <li key={p.id}>
                    <i aria-hidden />
                    <span>{p.subject}</span>
                    <button
                      type="button"
                      className="day-start"
                      disabled={!shown || busy}
                      onClick={async () => {
                        if (!shown) return;
                        setBusy(true);
                        try {
                          setMarks((await api<{ marks: Mark[] }>(`/incoming/days/${day}/marks`, { method: "POST", body: { path: shown.id, name: p.subject, email: p.email, childId: p.id } })).marks);
                        } catch (err) {
                          setNote({ tone: "bad", text: (err as Error).message });
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Start here
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="day-row">
            <button type="button" className="day-btn" onClick={() => setMode("none")}>
              Close <kbd>Esc</kbd>
            </button>
            <button type="button" className="day-btn primary" disabled={busy || counted.length === 0} onClick={() => void finish()}>
              Finish and sort
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
