import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Button, Callout, Field, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { plural } from "../../lib/galleries.js";

export interface SortFile {
  path: string;
  name: string;
  mtimeMs: number;
  ready: boolean;
}
interface Day {
  id: string;
  subject: string;
}
interface SortResult {
  people: Array<{ shootId: string; subject: string; frames: number }>;
  moved: number;
  skipped: Array<{ path: string; reason: string }>;
  leftOver: number;
}
interface Card {
  name: string;
  email: string;
}

/**
 * Splits one camera folder into people. Tap each frame that shows a person's name card (the whiteboard photo), type who it
 * is, and everything up to the next card goes to that person.
 */
export function NameCardSort({ files, days, thumb: Thumb, onClose, onDone }: { files: SortFile[]; days: Day[]; thumb: (p: { path: string }) => ReactElement; onClose: () => void; onDone: () => void | Promise<void> }) {
  const toast = useToast();
  const ordered = useMemo(() => files.filter((f) => f.ready).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name, undefined, { numeric: true })), [files]);
  const [dayId, setDayId] = useState(days[0]?.id ?? "");
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    if (!dayId) return;
    let live = true;
    api<{ items: Array<{ subject: string }> }>(`/shoots?parentId=${encodeURIComponent(dayId)}&limit=200`).then(
      (r) => live && setPeople(r.items.map((i) => i.subject)),
      () => live && setPeople([]),
    );
    return () => {
      live = false;
    };
  }, [dayId]);

  const marked = ordered.filter((f) => cards[f.path]);
  const firstMark = ordered.findIndex((f) => cards[f.path]);
  const leftOver = firstMark === -1 ? ordered.length : firstMark;
  const counts = marked.map((f, i) => {
    const start = ordered.indexOf(f);
    const end = i + 1 < marked.length ? ordered.indexOf(marked[i + 1]!) : ordered.length;
    return end - start;
  });
  const ready = marked.length > 0 && marked.every((f) => cards[f.path]!.name.trim()) && !!dayId;

  const toggle = (path: string) =>
    setCards((c) => {
      const n = { ...c };
      if (n[path]) delete n[path];
      else n[path] = { name: "", email: "" };
      return n;
    });
  const edit = (path: string, patch: Partial<Card>) => setCards((c) => ({ ...c, [path]: { ...c[path]!, ...patch } }));

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SortResult>("/incoming/sort", {
        method: "POST",
        body: { parentId: dayId, paths: ordered.map((f) => f.path), cards: marked.map((f) => ({ path: f.path, name: cards[f.path]!.name, email: cards[f.path]!.email || null })) },
      });
      toast(`${plural(r.people.length, "person", "people")} created, ${plural(r.moved, "photo")} sorted`);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Callout tone="info" title="Tap the name cards">
        Tap each photo that shows a person's name (the whiteboard shot). Photos after it belong to that person until the next name card.
      </Callout>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <div className={`agrid selecting`} role="group" aria-label="Photos in order taken">
        {ordered.map((f) => {
          const at = marked.indexOf(f);
          return (
            <button key={f.path} type="button" className="acell" aria-pressed={!!cards[f.path]} aria-label={`${f.name}${cards[f.path] ? ", name card" : ""}`} onClick={() => toggle(f.path)}>
              <Thumb path={f.path} />
              {at !== -1 ? <span className="tag cover">Person {at + 1}</span> : null}
              <span className="fname">{f.name}</span>
            </button>
          );
        })}
      </div>

      {marked.length ? (
        <div className="stack" aria-label="People">
          <datalist id="sort-people">
            {people.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {marked.map((f, i) => (
            <div key={f.path} className="form-grid" style={{ alignItems: "end" }}>
              <Field label={`Person ${i + 1} (${plural(counts[i]!, "photo")})`}>{(p) => <TextInput {...p} list="sort-people" autoComplete="off" value={cards[f.path]!.name} maxLength={120} placeholder="Name as written, or pick someone already here" onChange={(e) => edit(f.path, { name: e.target.value })} />}</Field>
              <Field label="Email">{(p) => <TextInput {...p} type="email" autoComplete="off" value={cards[f.path]!.email} maxLength={200} placeholder="Optional" onChange={(e) => edit(f.path, { email: e.target.value })} />}</Field>
            </div>
          ))}
        </div>
      ) : null}

      <div className="form-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <label className="sr-only" htmlFor="sort-day">
          Group day
        </label>
        <select id="sort-day" className="input slim in-target" value={dayId} onChange={(e) => setDayId(e.target.value)}>
          {days.map((d) => (
            <option key={d.id} value={d.id}>
              {d.subject}
            </option>
          ))}
        </select>
        <span className="hint" style={{ marginRight: "auto" }}>
          {marked.length ? `${plural(marked.length, "person", "people")}${leftOver ? `, ${plural(leftOver, "photo")} before the first card stay here` : ""}` : "No name cards marked yet"}
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" icon="check" loading={busy} disabled={!ready} onClick={() => void go()}>
          Create people and sort
        </Button>
      </div>
    </div>
  );
}
