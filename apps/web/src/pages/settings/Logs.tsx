import { useEffect, useState } from "react";
import { Button, Callout, EmptyState, Icon, Panel, Spinner, StatusChip } from "@openportrait/ui";
import { useLoad } from "../../lib/useLoad.js";
import { useSession } from "../../lib/session.js";
import { SwitchRow } from "../../components/SwitchRow.js";

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
interface Entry {
  time: number;
  level: Level;
  message: string;
  detail: string;
  raw: string;
}

const FILTERS: { value: Level; label: string }[] = [
  { value: "info", label: "Everything" },
  { value: "warn", label: "Warnings and errors" },
  { value: "error", label: "Errors only" },
];
const tone = (l: Level) => (l === "error" || l === "fatal" ? "bad" : l === "warn" ? "warn" : "neutral");

/** The app's own log, newest first, with a level filter, search, live refresh and a download for support. Owner only. */
export function LogsSettingsPage() {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const [level, setLevel] = useState<Level>("info");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const { data, error, loading, reload } = useLoad<{ entries: Entry[]; truncated: boolean; at: number }>(`/logs?level=${level}&limit=300${term ? `&q=${encodeURIComponent(term)}` : ""}`);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [live, reload]);

  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: tz });
  const entries = data?.entries ?? [];

  return (
    <Panel
      title="Logs"
      description="What the app has been doing, newest first. The last few megabytes are kept. Private links are masked, so the download is safe to send when asking for help."
      actions={
        <a className="btn sm" href="/api/studio/logs/download" download>
          <Icon name="download" /> Download
        </a>
      }
      flush
    >
      <div className="pad log-tools">
        <label className="log-field">
          <span className="label">Show</span>
          <select className="input" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="log-field log-search">
          <span className="label">Search</span>
          <input className="input" type="search" placeholder="Words, a path, an error" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="log-live">
          <SwitchRow checked={live} onChange={setLive} label="Refresh every 5 seconds" />
          <Button size="sm" onClick={() => void reload()} loading={loading && !!data}>Refresh</Button>
        </div>
      </div>
      {error ? <div className="pad"><Callout tone="bad">{error}</Callout></div> : null}
      {loading && !data ? <div className="pad"><Spinner label="Loading" /></div> : null}
      {data && entries.length === 0 ? (
        <EmptyState icon="info" title={term || level !== "info" ? "Nothing matches" : "No log yet"}>
          {term || level !== "info" ? "Try a different search or show everything." : "Entries appear here as the app runs."}
        </EmptyState>
      ) : (
        <ol className="log-list" aria-label="Log entries">
          {entries.map((e, i) => (
            <li key={`${e.time}-${i}`} className={`log-row ${e.level}`}>
              <button type="button" className="log-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                <time className="log-time">{e.time ? fmt.format(e.time) : ""}</time>
                <StatusChip tone={tone(e.level)}>{e.level}</StatusChip>
                <span className="log-msg">
                  {e.message}
                  {e.detail ? <small>{e.detail}</small> : null}
                </span>
              </button>
              {open === i ? <pre className="log-raw">{prettyRaw(e.raw)}</pre> : null}
            </li>
          ))}
        </ol>
      )}
      {data?.truncated ? <p className="pad hint">Showing the newest {entries.length}. Narrow the search or download the whole log.</p> : null}
    </Panel>
  );
}

function prettyRaw(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
