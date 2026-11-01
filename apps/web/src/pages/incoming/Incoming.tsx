import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Callout, EmptyState, Icon, PageHeader, Panel, Spinner, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { plural } from "../../lib/galleries.js";
import type { TetherSources } from "../../lib/tether.js";
import { useLoad } from "../../lib/useLoad.js";
import "./incoming.css";

interface IncomingFile {
  path: string;
  name: string;
  size: number;
  ready: boolean;
}
interface Group {
  key: string;
  label: string;
  date: string;
  files: IncomingFile[];
  bytes: number;
  suggestions: Array<{ id: string; subject: string }>;
}
interface Incoming {
  groups: Group[];
  total: number;
  dir: string;
}
interface MoveResult {
  moved: number;
  skipped: Array<{ path: string; reason: string }>;
  folder: string;
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const thumb = (p: string) => `/api/studio/tether/incoming/photo?path=${encodeURIComponent(p)}`;
const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** Camera files that arrived over SFTP, ready to be sorted into each shoot's RAW folder. */
export function IncomingPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Incoming>("/incoming");
  const shoots = useLoad<TetherSources>("/tether/sources");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("");
  const [moving, setMoving] = useState(false);
  const [result, setResult] = useState<MoveResult | null>(null);

  // New files keep arriving while the camera is shooting, so look again every few seconds.
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 8000);
    return () => window.clearInterval(t);
  }, [reload]);

  // Forget picks for files that are gone (moved here or by Lightroom).
  const present = useMemo(() => new Set(data?.groups.flatMap((g) => g.files.map((f) => f.path)) ?? []), [data]);
  useEffect(() => setSelected((s) => new Set([...s].filter((p) => present.has(p)))), [present]);

  const options = shoots.data?.shoots ?? [];
  const picked = data?.groups.filter((g) => g.files.some((f) => selected.has(f.path))) ?? [];
  const suggestion = picked.length === 1 ? picked[0]!.suggestions[0]?.id : undefined;
  useEffect(() => {
    if (suggestion) setTarget(suggestion);
  }, [suggestion]);

  const toggle = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const toggleGroup = (g: Group) =>
    setSelected((s) => {
      const n = new Set(s);
      const ready = g.files.filter((f) => f.ready).map((f) => f.path);
      if (ready.every((p) => n.has(p))) ready.forEach((p) => n.delete(p));
      else ready.forEach((p) => n.add(p));
      return n;
    });

  const move = async () => {
    setMoving(true);
    setResult(null);
    try {
      const r = await api<MoveResult>("/incoming/move", { method: "POST", body: { shootId: target, paths: [...selected] } });
      setResult(r);
      setSelected(new Set());
      toast(`Moved ${plural(r.moved, "photo")} to ${options.find((o) => o.id === target)?.subject ?? "the shoot"}`);
      await reload();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setMoving(false);
    }
  };

  return (
    <>
      <PageHeader title="Incoming" description="Photos sent from your camera, waiting to be sorted into a shoot's RAW folder." actions={<Link className="btn" to="/studio/tether"><Icon name="lan" /> Tethering</Link>} />

      {error && !data ? (
        <Callout tone="bad" title="Couldn't read the Incoming folder" action={<Button size="sm" onClick={() => reload()}>Try again</Button>}>
          {error}
        </Callout>
      ) : !data ? (
        <div className="detail-loading" aria-busy="true" aria-label="Loading">
          <Spinner />
        </div>
      ) : (
        <div className="stack">
          <Callout tone="info" title="Prefer Lightroom or Aftershoot?">
            You can open this folder straight from your computer instead. On your network it's the share that's mapped to <span className="mono">{data.dir}</span>. Nothing here is ever deleted or shown to clients.
          </Callout>

          {result?.skipped.length ? (
            <Callout tone="warn" title={`${plural(result.skipped.length, "photo")} stayed in Incoming`}>
              {[...new Set(result.skipped.map((s) => s.reason))].join(" ")}
            </Callout>
          ) : null}

          {data.groups.length === 0 ? (
            <Panel>
              <EmptyState icon="inbox" title="Nothing waiting">
                Photos your camera uploads over SFTP appear here as they arrive. <Link to="/studio/tether">Open Tethering</Link> to watch them land full screen.
              </EmptyState>
            </Panel>
          ) : (
            data.groups.map((g) => {
              const ready = g.files.filter((f) => f.ready);
              const all = ready.length > 0 && ready.every((f) => selected.has(f.path));
              return (
                <Panel key={g.key || "_"}>
                  <div className="in-head">
                    <div>
                      <h2 className="in-title">{g.label}</h2>
                      <span className="hint">
                        {dayLabel(g.date)} · {plural(g.files.length, "photo")} · {size(g.bytes)}
                        {g.suggestions.length ? ` · Looks like ${g.suggestions.map((s) => s.subject).join(" or ")}` : ""}
                      </span>
                    </div>
                    <Button size="sm" onClick={() => toggleGroup(g)} disabled={ready.length === 0}>
                      {all ? "Clear" : `Select all ${ready.length}`}
                    </Button>
                  </div>
                  <div className={`agrid${selected.size ? " selecting" : ""}`}>
                    {g.files.map((f) => (
                      <button key={f.path} type="button" className={`acell${f.ready ? "" : " pending"}`} aria-pressed={selected.has(f.path)} disabled={!f.ready} aria-label={`${f.name}${f.ready ? "" : ", still arriving"}`} onClick={() => toggle(f.path)}>
                        {f.ready ? <Thumb path={f.path} /> : <span className="acell-ph"><Icon name="refresh" /></span>}
                        {!f.ready ? <span className="tag">Arriving</span> : null}
                        <span className="sel">{selected.has(f.path) ? <Icon name="check" width={14} height={14} /> : null}</span>
                        <span className="fname">{f.name}</span>
                      </button>
                    ))}
                  </div>
                </Panel>
              );
            })
          )}

          {selected.size ? (
            <div className="bulk" role="region" aria-label="Selected photos">
              <span className="n">{plural(selected.size, "photo")} selected</span>
              <label className="sr-only" htmlFor="in-target">
                Move to shoot
              </label>
              <select id="in-target" className="input slim in-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Move to which shoot?</option>
                {options.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.subject} · {s.shootType}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="primary" onClick={move} disabled={!target || moving}>
                {moving ? "Moving…" : "Move to shoot"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          ) : loading || shoots.loading ? null : data.groups.length && !options.length ? (
            <Callout tone="neutral" title="No shoots with a folder yet">Create a shoot (it gets its folder when it has a date), then come back to sort these into it.</Callout>
          ) : null}
        </div>
      )}
    </>
  );
}

function Thumb({ path }: { path: string }) {
  const [bad, setBad] = useState(false);
  return bad ? (
    <span className="acell-ph" title="No preview in this file">
      <Icon name="image" />
    </span>
  ) : (
    <img src={thumb(path)} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} />
  );
}
