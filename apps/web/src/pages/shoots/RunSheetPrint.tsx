import { Link, useParams } from "react-router";
import { Button, Callout, Icon, Spinner } from "@openportrait/ui";
import { clock, lasts, type RunItem } from "../../components/RunSheet.js";
import { useSession } from "../../lib/session.js";
import { formatDate, formatTime, ms } from "../../lib/time.js";
import type { ShootDetail } from "../../lib/types.js";
import { useLoad } from "../../lib/useLoad.js";

/** A printable page: the shoot's details up top, then the timeline. Navigation is hidden when printing. */
export function RunSheetPrintPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const shoot = useLoad<ShootDetail>(`/shoots/${id}`);
  const run = useLoad<{ items: RunItem[] }>(`/shoots/${id}/run-sheet`);
  const s = shoot.data;
  const items = run.data?.items ?? [];
  const error = shoot.error ?? run.error;

  return (
    <div className="run-sheet">
      <div className="run-bar no-print">
        <Link to={`/studio/shoots/${id}`} className="back">
          <Icon name="arrowLeft" /> Back to the shoot
        </Link>
        <Button variant="primary" icon="note" onClick={() => window.print()} disabled={!s}>
          Print
        </Button>
      </div>
      {error ? <Callout tone="bad" title="Couldn't open the run sheet">{error}</Callout> : null}
      {!s || !run.data ? !error ? <Spinner label="Loading the run sheet" /> : null : (
        <article className="run-page">
          <header>
            <p className="eyebrow">{me?.studio.name} · Run sheet</p>
            <h1>{s.subject}</h1>
            <p className="run-sub">{s.shootType.name}</p>
          </header>
          <dl className="run-facts">
            {s.events.map((ev) => (
              <div key={ev.id}>
                <dt>{ev.title || "When"}</dt>
                <dd>
                  {formatDate(ms(ev.startsAt), tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  {!ev.allDay ? `, ${formatTime(ms(ev.startsAt), tz)} to ${formatTime(ms(ev.endsAt), tz)}` : ""}
                  {ev.location ? <> · {ev.location}</> : null}
                </dd>
              </div>
            ))}
            <div>
              <dt>Client</dt>
              <dd>
                {s.primary.name}
                {s.primary.phone ? ` · ${s.primary.phone}` : ""}
              </dd>
            </div>
            {s.contacts.map((c) => (
              <div key={c.contactId}>
                <dt>{c.role || "Also there"}</dt>
                <dd>{c.name}</dd>
              </div>
            ))}
          </dl>
          {items.length === 0 ? (
            <p className="hint">No timeline lines yet. Add some on the shoot page.</p>
          ) : (
            <ol className="run-table">
              {items.map((it) => (
                <li key={it.id}>
                  <div className="t">
                    <b>{clock(it.startMinutes)}</b>
                    {it.durationMinutes ? <span>{lasts(it.durationMinutes)}</span> : null}
                  </div>
                  <div className="w">
                    <b>{it.title}</b>
                    {it.location ? <span>{it.location}</span> : null}
                    {it.notes ? <p>{it.notes}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </article>
      )}
    </div>
  );
}
