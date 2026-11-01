import { useEffect, useState } from "react";
import { Callout, EmptyState, Icon, Panel, Spinner, type IconName } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { formatDate, plural, timeAgo, type GalleryDetail } from "../../lib/galleries.js";

type Kind = "view" | "download" | "favorites" | "registered" | "email" | "shared";
interface Activity {
  summary: { views: number; downloads: number; favoritesSent: number; registered: number; people: number; lastVisit: number | null };
  events: Array<{ at: number; kind: Kind; who: string | null; text: string }>;
}

const ICON: Record<Kind, IconName> = { view: "eye", download: "download", favorites: "heart", registered: "user", email: "mail", shared: "send" };
const day = (ms: number) => new Date(ms).toDateString();

/** Who has looked at this gallery and what they did, newest first. */
export function ActivityTab({ data }: { data: GalleryDetail }) {
  const id = data.gallery.id;
  const [a, setA] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Activity>(`/galleries/${id}/activity`)
        .then((r) => !stop && (setA(r), setError(null)))
        .catch((e: Error) => !stop && setError(e.message));
    void load();
    const t = window.setInterval(load, 15000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [id]);

  if (error && !a) return <Callout tone="bad" title="Couldn't load activity">{error}</Callout>;
  if (!a)
    return (
      <div className="detail-loading" aria-busy="true" aria-label="Loading activity">
        <Spinner />
      </div>
    );

  const s = a.summary;
  const stats: Array<[string, string, string?]> = [
    ["Visits", s.views.toLocaleString(), s.lastVisit ? `Last ${timeAgo(s.lastVisit)}` : "None yet"],
    ["People", s.people.toLocaleString(), s.registered ? `${s.registered} registered` : undefined],
    ["Downloads", s.downloads.toLocaleString()],
    ["Favorites sent", s.favoritesSent.toLocaleString()],
  ];

  let lastDay = "";
  return (
    <div className="stack">
      <div className="act-stats">
        {stats.map(([label, value, note]) => (
          <div key={label} className="act-stat">
            <span>{label}</span>
            <b>{value}</b>
            {note ? <em>{note}</em> : null}
          </div>
        ))}
      </div>
      <Panel title="Timeline" description="Visits are counted once per visitor every 30 minutes.">
        {a.events.length <= 1 && !s.views ? (
          <EmptyState icon="clock" title="No one has opened this gallery yet">
            {data.gallery.status === "live" ? "Visits, downloads and favorites show up here as they happen." : "Share the gallery with your client and their activity shows up here."}
          </EmptyState>
        ) : (
          <ol className="act-list">
            {a.events.map((e, i) => {
              const header = day(e.at) !== lastDay ? ((lastDay = day(e.at)), formatDate(e.at, { weekday: "long", month: "long", day: "numeric", year: "numeric" })) : null;
              return (
                <li key={`${e.at}-${i}`}>
                  {header ? <h3 className="act-day">{header}</h3> : null}
                  <div className={`act-row ${e.kind}`}>
                    <span className="act-ico" aria-hidden>
                      <Icon name={ICON[e.kind]} />
                    </span>
                    <span className="act-txt">
                      <b>{e.who ?? (e.kind === "shared" ? "You" : "Someone")}</b> {e.text.charAt(0).toLowerCase() + e.text.slice(1)}
                    </span>
                    <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
                      {new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
      {a.events.length >= 300 ? <p className="hint">Showing the latest {plural(300, "event")}.</p> : null}
    </div>
  );
}
