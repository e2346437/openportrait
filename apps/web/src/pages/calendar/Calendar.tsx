import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, EmptyState, PageHeader, StatusChip, useToast } from "@openportrait/ui";
import { addDays, addMonths, dayStart, formatDay, itemsByDay, layoutLanes, monthWeeks, onDay, startOfMonth, startOfWeek, ymdOf, type CalendarItem, type Ymd } from "../../lib/calendar.js";
import { formatTime, relative } from "../../lib/time.js";
import { useSession } from "../../lib/session.js";
import { useLoad } from "../../lib/useLoad.js";
import { EntryDialog, type EntryTarget } from "./EntryDialog.js";

type View = "month" | "week" | "agenda";
const VIEWS: View[] = ["month", "week", "agenda"];
const HOUR_PX = 52;
const AGENDA_DAYS = 30;

const SOURCE_LABEL = { shoot: "Shoot", appointment: "Appointment", block: "Time off", busy: "Busy elsewhere" } as const;

function rangeFor(view: View, anchor: Ymd): { days: Ymd[]; from: Ymd; to: Ymd } {
  if (view === "month") {
    const weeks = monthWeeks(anchor);
    const days = weeks.flat();
    return { days, from: days[0]!, to: addDays(days[days.length - 1]!, 1) };
  }
  if (view === "week") {
    const s = startOfWeek(anchor);
    return { days: Array.from({ length: 7 }, (_, i) => addDays(s, i)), from: s, to: addDays(s, 7) };
  }
  return { days: Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(anchor, i)), from: anchor, to: addDays(anchor, AGENDA_DAYS) };
}

export function CalendarPage() {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const today = ymdOf(Date.now(), tz);
  const view = (VIEWS.includes(params.get("view") as View) ? params.get("view") : "month") as View;
  const rawDay = params.get("d");
  const anchor: Ymd = rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : today;
  const [selected, setSelected] = useState<Ymd>(anchor);
  const [target, setTarget] = useState<EntryTarget>(null);

  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const { data, error, loading, reload } = useLoad<{ items: CalendarItem[] }>(`/calendar?from=${dayStart(range.from, tz)}&to=${dayStart(range.to, tz)}`);
  const byDay = useMemo(() => itemsByDay(data?.items ?? [], range.days, tz), [data, range.days, tz]);
  const owner = me?.user?.role === "owner";
  const google = useLoad<{ connected: boolean; configured: boolean; lastSyncAt: number | null; needsReconnect: boolean }>(owner ? "/google" : null);

  const go = (next: Partial<{ view: View; d: Ymd }>) => {
    const p = new URLSearchParams(params);
    if (next.view) p.set("view", next.view);
    if (next.d) p.set("d", next.d);
    setParams(p, { replace: true });
    if (next.d) setSelected(next.d);
  };
  const step = (dir: -1 | 1) => go({ d: view === "month" ? addMonths(startOfMonth(anchor), dir) : addDays(anchor, dir * (view === "week" ? 7 : AGENDA_DAYS)) });

  const label =
    view === "month" ? formatDay(anchor, { month: "long", year: "numeric" }) : view === "week" ? `${formatDay(range.days[0]!, { month: "short", day: "numeric" })} to ${formatDay(range.days[6]!, { month: "short", day: "numeric", year: "numeric" })}` : `${formatDay(anchor, { month: "short", day: "numeric" })} onward`;

  const open = (item: CalendarItem) => {
    if (item.source === "shoot" && item.shootId) navigate(`/studio/shoots/${item.shootId}`);
    else if (item.source === "appointment" || item.source === "block") setTarget({ mode: "edit", item });
  };

  // Keyboard: arrows move the range, "t" jumps to today, "n" adds. Ignored while typing.
  const key = useRef<(e: KeyboardEvent) => void>(() => undefined);
  key.current = (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "t") go({ d: today });
    else if (e.key === "n") setTarget({ mode: "new", ymd: selected });
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => key.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Shoots, appointments and time off, in one place."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setTarget({ mode: "new", ymd: selected })}>
            Add
          </Button>
        }
      />
      <div className="cal-bar">
        <div className="cal-nav">
          <Button size="sm" onClick={() => go({ d: today })}>
            Today
          </Button>
          <Button size="sm" className="icon" icon="chevronLeft" aria-label="Previous" onClick={() => step(-1)} />
          <Button size="sm" className="icon" icon="chevronRight" aria-label="Next" onClick={() => step(1)} />
          <h2 className="cal-label" aria-live="polite">
            {label}
          </h2>
        </div>
        <div className="seg" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => go({ view: v })}>
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <EmptyState icon="calendar" title="Couldn't load the calendar" action={<Button onClick={reload}>Try again</Button>}>
          {error}
        </EmptyState>
      ) : view === "month" ? (
        <MonthView weeks={monthWeeks(anchor)} anchor={anchor} today={today} selected={selected} byDay={byDay} loading={loading} tz={tz} onSelect={setSelected} onOpen={open} onAdd={(d) => setTarget({ mode: "new", ymd: d })} />
      ) : view === "week" ? (
        <WeekView days={range.days} today={today} byDay={byDay} tz={tz} loading={loading} onOpen={open} onAdd={(d) => setTarget({ mode: "new", ymd: d })} />
      ) : (
        <AgendaView days={range.days} today={today} byDay={byDay} tz={tz} loading={loading} onOpen={open} />
      )}

      <GoogleLine owner={owner} state={google.data} />
      <EntryDialog
        target={target}
        tz={tz}
        onClose={() => setTarget(null)}
        onSaved={(m) => {
          setTarget(null);
          toast(m);
          reload();
        }}
      />
    </>
  );
}

function GoogleLine({ owner, state }: { owner: boolean; state: { connected: boolean; configured: boolean; lastSyncAt: number | null; needsReconnect: boolean } | null }) {
  if (!owner || !state) return null;
  if (state.connected && !state.needsReconnect)
    return (
      <p className="cal-foot">
        <StatusChip tone="ok">Google Calendar</StatusChip> {state.lastSyncAt ? `Synced ${relative(state.lastSyncAt)}.` : "First sync in progress."} <Link to="/studio/settings/calendar">Settings</Link>
      </p>
    );
  if (state.connected)
    return (
      <p className="cal-foot">
        <StatusChip tone="warn">Google Calendar</StatusChip> Sign-in expired. <Link to="/studio/settings/calendar">Reconnect</Link>
      </p>
    );
  return (
    <p className="cal-foot">
      <Link to="/studio/settings/calendar">Connect Google Calendar</Link> to see this on your phone and keep personal events out of the way.
    </p>
  );
}

function ItemChip({ item, tz, onOpen, compact }: { item: CalendarItem; tz: string; onOpen: (i: CalendarItem) => void; compact?: boolean }) {
  const clickable = item.source !== "busy";
  const time = item.allDay ? "" : formatTime(item.startsAt, tz).replace(":00", "").replace(" ", "").toLowerCase();
  const content = (
    <>
      {compact && time ? <span className="t">{time}</span> : null}
      <span className="n">{item.title}</span>
    </>
  );
  const common = { className: `ev ${item.source}`, title: `${SOURCE_LABEL[item.source]}: ${item.title}${item.allDay ? "" : `, ${formatTime(item.startsAt, tz)} to ${formatTime(item.endsAt, tz)}`}` };
  return clickable ? (
    <button type="button" {...common} onClick={() => onOpen(item)}>
      {content}
    </button>
  ) : (
    <div {...common}>{content}</div>
  );
}

function MonthView({ weeks, anchor, today, selected, byDay, loading, tz, onSelect, onOpen, onAdd }: { weeks: Ymd[][]; anchor: Ymd; today: Ymd; selected: Ymd; byDay: Map<Ymd, CalendarItem[]>; loading: boolean; tz: string; onSelect: (d: Ymd) => void; onOpen: (i: CalendarItem) => void; onAdd: (d: Ymd) => void }) {
  const month = anchor.slice(0, 7);
  const selectedItems = byDay.get(selected) ?? [];
  return (
    <>
      <div className={`month${loading ? " loading" : ""}`} role="grid" aria-label={formatDay(anchor, { month: "long", year: "numeric" })} aria-busy={loading}>
        <div className="month-head" role="row">
          {weeks[0]!.map((d) => (
            <span key={d} role="columnheader">
              {formatDay(d, { weekday: "short" })}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div className="month-week" role="row" key={week[0]}>
            {week.map((d) => {
              const items = byDay.get(d) ?? [];
              const shown = items.slice(0, 3);
              return (
                <div key={d} role="gridcell" className={`day${d.startsWith(month) ? "" : " out"}${d === today ? " today" : ""}${d === selected ? " selected" : ""}`} aria-selected={d === selected}>
                  <button type="button" className="day-num" onClick={() => onSelect(d)} aria-label={`${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}, ${items.length} ${items.length === 1 ? "item" : "items"}`}>
                    {Number(d.slice(8))}
                  </button>
                  <div className="day-events">
                    {shown.map((i) => (
                      <ItemChip key={i.key} item={i} tz={tz} onOpen={onOpen} compact />
                    ))}
                    {items.length > shown.length ? (
                      <button type="button" className="more" onClick={() => onSelect(d)}>
                        +{items.length - shown.length} more
                      </button>
                    ) : null}
                  </div>
                  {items.length ? (
                    <span className="dots" aria-hidden="true">
                      {items.slice(0, 4).map((i) => (
                        <i key={i.key} className={i.source} />
                      ))}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <section className="day-panel" aria-label={formatDay(selected, { weekday: "long", month: "long", day: "numeric" })}>
        <header>
          <h3>{selected === today ? "Today" : formatDay(selected, { weekday: "long", month: "long", day: "numeric" })}</h3>
          <Button size="sm" icon="plus" onClick={() => onAdd(selected)}>
            Add
          </Button>
        </header>
        {selectedItems.length ? (
          <ul className="agenda-list">
            {selectedItems.map((i) => (
              <AgendaRow key={i.key} item={i} tz={tz} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing scheduled.</p>
        )}
      </section>
    </>
  );
}

function AgendaRow({ item, tz, onOpen }: { item: CalendarItem; tz: string; onOpen: (i: CalendarItem) => void }) {
  const clickable = item.source !== "busy";
  const body = (
    <>
      <span className="when">{item.allDay ? "All day" : `${formatTime(item.startsAt, tz)}`}</span>
      <span className={`bar ${item.source}`} aria-hidden="true" />
      <span className="what">
        <b>{item.title}</b>
        <small>
          {[item.source === "shoot" ? item.shootType : SOURCE_LABEL[item.source], item.contactName && item.source !== "shoot" ? item.contactName : null, item.location].filter(Boolean).join(" · ")}
          {!item.allDay && item.source !== "busy" ? ` · until ${formatTime(item.endsAt, tz)}` : ""}
        </small>
      </span>
    </>
  );
  return <li>{clickable ? <button type="button" className="agenda-row" onClick={() => onOpen(item)}>{body}</button> : <div className="agenda-row static">{body}</div>}</li>;
}

function AgendaView({ days, today, byDay, tz, loading, onOpen }: { days: Ymd[]; today: Ymd; byDay: Map<Ymd, CalendarItem[]>; tz: string; loading: boolean; onOpen: (i: CalendarItem) => void }) {
  const busyDays = days.filter((d) => (byDay.get(d) ?? []).length);
  if (!loading && !busyDays.length) return <EmptyState icon="calendar" title="Nothing in the next 30 days">Shoots, appointments and time off show up here as you add them.</EmptyState>;
  return (
    <div className={`agenda${loading ? " loading" : ""}`} aria-busy={loading}>
      {busyDays.map((d) => (
        <section key={d}>
          <h3 className={d === today ? "today" : ""}>
            {d === today ? "Today" : formatDay(d, { weekday: "long" })} <span>{formatDay(d, { month: "short", day: "numeric" })}</span>
          </h3>
          <ul className="agenda-list">
            {byDay.get(d)!.map((i) => (
              <AgendaRow key={i.key} item={i} tz={tz} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function WeekView({ days, today, byDay, tz, loading, onOpen, onAdd }: { days: Ymd[]; today: Ymd; byDay: Map<Ymd, CalendarItem[]>; tz: string; loading: boolean; onOpen: (i: CalendarItem) => void; onAdd: (d: Ymd) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = HOUR_PX * 7 - 10;
  }, [days[0]]);
  const nowMin = (() => {
    const t = dayStart(today, tz);
    return Math.round((now - t) / 60_000);
  })();
  return (
    <div className={`week${loading ? " loading" : ""}`} aria-busy={loading}>
      <div className="week-head">
        <span />
        {days.map((d) => (
          <button type="button" key={d} className={d === today ? "today" : ""} onClick={() => onAdd(d)} aria-label={`Add on ${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}`}>
            <small>{formatDay(d, { weekday: "short" })}</small>
            <b>{Number(d.slice(8))}</b>
          </button>
        ))}
      </div>
      <div className="week-allday">
        <span>all day</span>
        {days.map((d) => (
          <div key={d}>
            {(byDay.get(d) ?? []).filter((i) => i.allDay).map((i) => (
              <ItemChip key={i.key} item={i} tz={tz} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </div>
      <div className="week-scroll" ref={scroller}>
        <div className="week-grid" style={{ height: HOUR_PX * 24 }}>
          <div className="hours">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h)))}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const timed = (byDay.get(d) ?? []).filter((i) => !i.allDay).map((i) => ({ item: i, ...onDay(i, d, tz)! }));
            return (
              <div key={d} className={`col-day${d === today ? " today" : ""}`}>
                {layoutLanes(timed).map(({ item, start, end, lane, lanes }) => (
                  <div key={item.key} className={`slot ${item.source}${end - start < 45 ? " short" : ""}`} style={{ top: (start / 60) * HOUR_PX, height: Math.max(((end - start) / 60) * HOUR_PX - 2, 20), left: `${(lane / lanes) * 100}%`, width: `calc(${100 / lanes}% - 3px)` }}>
                    {item.source === "busy" ? (
                      <span className="n">Busy</span>
                    ) : (
                      <button type="button" onClick={() => onOpen(item)} title={`${item.title}, ${formatTime(item.startsAt, tz)} to ${formatTime(item.endsAt, tz)}`}>
                        <span className="n">{item.title}</span>
                        <span className="t">{formatTime(item.startsAt, tz)}</span>
                      </button>
                    )}
                  </div>
                ))}
                {d === today && nowMin >= 0 && nowMin < 1440 ? <div className="now" style={{ top: (nowMin / 60) * HOUR_PX }} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
