import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Button, Callout, Field, Icon, Spinner, TextArea, TextInput } from "@openportrait/ui";
import { publicApi } from "../../lib/api.js";
import { addDays, addMonths, formatDay, monthWeeks, startOfMonth, ymdOf, type Ymd } from "../../lib/calendar.js";
import { formatTime } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { PublicMessage, PublicShell } from "./PublicShell.js";

interface Page {
  name: string;
  description: string | null;
  durationMinutes: number;
  location: string | null;
  approval: "manual" | "auto";
  studioName: string;
  timezone: string;
  maxDaysAhead: number;
}
type Slots = Record<string, Array<{ startsAt: number; endsAt: number }>>;
interface Made {
  status: "pending" | "confirmed";
  when: string;
}

const tzName = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;

/** A booking page: pick a day, pick a time, say who you are. */
export function BookPage() {
  const { slug = "" } = useParams();
  const { data: page, error, loading } = useLoad<Page>(`/book/${encodeURIComponent(slug)}`, { api: publicApi });
  const [month, setMonth] = useState<Ymd | null>(null);
  const [day, setDay] = useState<Ymd | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", message: "", website: "" });
  const tz = page?.timezone ?? "UTC";
  const today = ymdOf(Date.now(), tz);
  const shown = month ?? startOfMonth(today);
  const weeks = useMemo(() => monthWeeks(shown), [shown]);
  const from = weeks[0]![0]!;
  const to = weeks[weeks.length - 1]![6]!;
  const slots = useLoad<{ days: Slots }>(page ? `/book/${encodeURIComponent(slug)}/slots?from=${from}&to=${to}` : null, { api: publicApi });
  const days = slots.data?.days ?? {};
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    // Open on the first day that has times, so nobody lands on an empty month.
    if (!day && slots.data) {
      const first = Object.keys(slots.data.days).sort()[0];
      if (first) {
        setDay(first);
        setMonth(startOfMonth(first));
      }
    }
  }, [slots.data, day]);

  const book = useSubmit(() => publicApi<Made>(`/book/${encodeURIComponent(slug)}`, { body: { ...f, startsAt: slot } }));
  const taken = book.error && /just taken/i.test(book.error);
  useEffect(() => {
    if (taken) {
      setSlot(null);
      slots.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taken]);

  if (loading) return <PublicShell narrow><Spinner label="Loading" /></PublicShell>;
  if (error || !page) return <PublicMessage title="This booking page isn't available">It may have been turned off. Please contact the studio directly.</PublicMessage>;

  if (made)
    return (
      <PublicShell studio={page.studioName} narrow>
        <h1 className="pub-title">{made.status === "confirmed" ? "You're booked" : "Request sent"}</h1>
        <p className="pub-lead" role="status">
          {made.status === "confirmed" ? `${page.name} is confirmed for ${made.when}.` : `You asked for ${page.name} on ${made.when}. The time is held for you, and you'll get an email as soon as it's confirmed.`}
        </p>
        <p className="muted">A copy is on its way to {f.email}, with a link if you need to cancel.</p>
      </PublicShell>
    );

  const times = day ? (days[day] ?? []) : [];
  const go = async (e: FormEvent) => {
    e.preventDefault();
    const res = await book.submit();
    if (res) setMade(res);
  };
  const monthIsCurrent = shown <= startOfMonth(today);
  const lastMonth = startOfMonth(addDays(today, page.maxDaysAhead));

  return (
    <PublicShell studio={page.studioName}>
      <div className="book">
        <section className="book-info">
          <h1 className="pub-title">{page.name}</h1>
          <ul className="book-facts">
            <li>
              <Icon name="clock" width={16} height={16} /> {page.durationMinutes} minutes
            </li>
            {page.location ? (
              <li>
                <Icon name="pin" width={16} height={16} /> {page.location}
              </li>
            ) : null}
          </ul>
          {page.description ? <p className="pub-lead">{page.description}</p> : null}
          {page.approval === "manual" ? <p className="muted">Requests are confirmed by email.</p> : null}
        </section>

        <section className="book-pick" aria-label="Choose a time">
          <div className="book-month">
            <button type="button" className="btn sm icon" aria-label="Previous month" disabled={monthIsCurrent} onClick={() => setMonth(addMonths(shown, -1))}>
              <Icon name="chevronLeft" />
            </button>
            <h2>{formatDay(shown, { month: "long", year: "numeric" })}</h2>
            <button type="button" className="btn sm icon" aria-label="Next month" disabled={shown >= lastMonth} onClick={() => setMonth(addMonths(shown, 1))}>
              <Icon name="chevronRight" />
            </button>
          </div>
          <div className={`book-grid${slots.loading ? " loading" : ""}`} role="grid" aria-busy={slots.loading}>
            {weeks[0]!.map((d) => (
              <span key={d} className="dow" role="columnheader">
                {formatDay(d, { weekday: "narrow" })}
              </span>
            ))}
            {weeks.flat().map((d) => {
              const inMonth = d.startsWith(shown.slice(0, 7));
              const has = !!days[d]?.length;
              return (
                <button key={d} type="button" role="gridcell" disabled={!has} className={`bd${d === day ? " on" : ""}${!inMonth ? " out" : ""}${d === today ? " today" : ""}`} aria-pressed={d === day} aria-label={`${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}${has ? "" : ", no times"}`} onClick={() => { setDay(d); setSlot(null); }}>
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
          <p className="book-tz">Times are in {tzName(tz)}.</p>
          {slots.error ? <Callout tone="bad">{slots.error}</Callout> : null}
          {!slots.loading && !slots.error && Object.keys(days).length === 0 ? <p className="muted">No times are open this month. Try the next one.</p> : null}

          {day && times.length ? (
            <>
              <h3 className="book-day">{formatDay(day, { weekday: "long", month: "long", day: "numeric" })}</h3>
              <div className="book-times" role="group" aria-label="Times">
                {times.map((t) => (
                  <button key={t.startsAt} type="button" className={`bt${slot === t.startsAt ? " on" : ""}`} aria-pressed={slot === t.startsAt} onClick={() => setSlot(t.startsAt)}>
                    {formatTime(t.startsAt, tz)}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {slot ? (
            <form onSubmit={go} noValidate className="form-grid pub-form book-form">
              <h3 className="span-2 book-day">Your details</h3>
              {book.error && !taken ? (
                <div className="span-2">
                  <Callout tone="bad">{book.error}</Callout>
                </div>
              ) : null}
              {taken ? (
                <div className="span-2">
                  <Callout tone="warn">That time was just taken. Please pick another.</Callout>
                </div>
              ) : null}
              <Field label="First name" error={book.fieldErrors.firstName}>
                {(p) => <TextInput {...p} autoComplete="given-name" required value={f.firstName} onChange={set("firstName")} />}
              </Field>
              <Field label="Last name">
                {(p) => <TextInput {...p} autoComplete="family-name" value={f.lastName} onChange={set("lastName")} />}
              </Field>
              <Field className="span-2" label="Email" error={book.fieldErrors.email}>
                {(p) => <TextInput {...p} type="email" autoComplete="email" required value={f.email} onChange={set("email")} />}
              </Field>
              <Field className="span-2" label="Phone" hint="Optional.">
                {(p) => <TextInput {...p} type="tel" autoComplete="tel" value={f.phone} onChange={set("phone")} />}
              </Field>
              <Field className="span-2" label="Anything I should know?" hint="Optional.">
                {(p) => <TextArea {...p} rows={3} maxLength={2000} value={f.message} onChange={set("message")} />}
              </Field>
              <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
                <label>
                  Website
                  <input type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
                </label>
              </div>
              <div className="span-2">
                <Button variant="primary" type="submit" size="lg" block loading={book.busy}>
                  {page.approval === "auto" ? "Book it" : "Request this time"}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </PublicShell>
  );
}
