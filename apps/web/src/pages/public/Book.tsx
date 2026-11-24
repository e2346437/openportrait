import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Button, Callout, Field, Icon, Spinner, TextArea, TextInput } from "@openportrait/ui";
import { publicApi } from "../../lib/api.js";
import { addDays, addMonths, formatDay, monthWeeks, startOfMonth, ymdOf, type Ymd } from "../../lib/calendar.js";
import { formatMoney } from "../../lib/money.js";
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
  price: Price | null;
}
interface Price {
  currency: string;
  priceCents: number;
  couponCode: string | null;
  couponCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  balanceCents: number;
}
type Slots = Record<string, Array<{ startsAt: number; endsAt: number }>>;
interface Made {
  status: "pending" | "confirmed";
  when: string;
  invoice: { token: string; totalCents: number; depositCents: number; currency: string; contractUrl?: string | null } | null;
}
interface OrderPay {
  pay: { name: string; dueCents: number } | null;
}

/** Right after a paid booking: pay the retainer (or the whole amount) through the studio's online checkout, or see how else to pay. */
function DepositStep({ made }: { made: NonNullable<Made["invoice"]> }) {
  const order = useLoad<OrderPay>(`/order/${encodeURIComponent(made.token)}`, { api: publicApi });
  const go = useSubmit(async () => {
    const r = await publicApi<{ approveUrl: string }>(`/order/${encodeURIComponent(made.token)}/pay`, { body: { amount: "due" } });
    window.location.assign(r.approveUrl);
    return r;
  });
  const m = (c: number) => formatMoney(c, made.currency);
  const split = made.depositCents > 0 && made.depositCents < made.totalCents;
  const due = order.data?.pay?.dueCents ?? (split ? made.depositCents : made.totalCents);
  return (
    <section className="doc-section pay-box" aria-label="Payment">
      {made.contractUrl ? (
        <>
          <h2>Sign your agreement</h2>
          <p className="muted">Please sign first. We've also emailed you the link. Then you can pay {split ? "your retainer" : "online"}.</p>
          <div className="form-actions"><a className="btn primary lg" href={made.contractUrl}>Review and sign</a></div>
        </>
      ) : null}
      <h2>{split ? "Pay your retainer" : "Pay for your session"}</h2>
      {go.error ? <Callout tone="bad">{go.error}</Callout> : null}
      <p className="muted">
        {split ? `A ${m(made.depositCents)} retainer holds your time. The remaining ${m(made.totalCents - made.depositCents)} is due on the day.` : `The total is ${m(made.totalCents)}.`}
      </p>
      <div className="form-actions">
        {order.loading ? (
          <Spinner label="Checking payment options" />
        ) : order.data?.pay ? (
          <Button variant="primary" size="lg" loading={go.busy} onClick={() => go.submit()}>
            Pay {m(due)} with {order.data.pay.name}
          </Button>
        ) : null}
        <a className="btn lg" href={`/o/${made.token}`}>{order.data?.pay ? "View invoice" : "View invoice and how to pay"}</a>
      </div>
      {order.data?.pay ? <p className="muted">You'll finish on {order.data.pay.name}'s secure page, then come straight back to your invoice.</p> : null}
    </section>
  );
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

  const [code, setCode] = useState("");
  const [priced, setPriced] = useState<Price | null>(null);
  const [couponNote, setCouponNote] = useState<string | null>(null);
  const check = useSubmit(async () => {
    const r = await publicApi<{ price: Price }>(`/book/${encodeURIComponent(slug)}/price`, { body: { couponCode: code } });
    setPriced(r.price);
    setCouponNote(r.price.couponCode ? `${r.price.couponCode} applied.` : null);
    return r;
  });
  const price = priced ?? page?.price ?? null;
  const book = useSubmit(() => publicApi<Made>(`/book/${encodeURIComponent(slug)}`, { body: { ...f, startsAt: slot, couponCode: priced?.couponCode ?? undefined } }));
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
        {made.invoice ? <DepositStep made={made.invoice} /> : null}
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
            {page.price ? (
              <li>
                <Icon name="receipt" width={16} height={16} /> {formatMoney(page.price.totalCents, page.price.currency)}
                {page.price.depositCents > 0 && page.price.depositCents < page.price.totalCents ? `, ${formatMoney(page.price.depositCents, page.price.currency)} retainer` : ""}
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
              {price ? (
                <div className="span-2 book-price">
                  <dl className="totals">
                    <div><dt>{page.name}</dt><dd>{formatMoney(price.priceCents, price.currency)}</dd></div>
                    {price.couponCents ? <div><dt>Coupon {price.couponCode}</dt><dd>−{formatMoney(price.couponCents, price.currency)}</dd></div> : null}
                    {price.taxCents ? <div><dt>Tax</dt><dd>{formatMoney(price.taxCents, price.currency)}</dd></div> : null}
                    <div className="grand"><dt>Total</dt><dd>{formatMoney(price.totalCents, price.currency)}</dd></div>
                    {price.depositCents > 0 && price.depositCents < price.totalCents ? <div><dt>Retainer, due after booking</dt><dd>{formatMoney(price.depositCents, price.currency)}</dd></div> : null}
                  </dl>
                  <div className="coupon-row">
                    <Field label="Have a coupon?" error={check.error ?? undefined} hint={couponNote ?? undefined}>
                      {(p) => (
                        <TextInput
                          {...p}
                          autoCapitalize="characters"
                          spellCheck={false}
                          autoComplete="off"
                          value={code}
                          onChange={(e) => { setCode(e.target.value); if (priced?.couponCode) { setPriced(null); setCouponNote(null); } }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (code.trim()) void check.submit(); } }}
                        />
                      )}
                    </Field>
                    <Button type="button" loading={check.busy} disabled={!code.trim()} onClick={() => check.submit()}>Apply</Button>
                  </div>
                </div>
              ) : null}
              <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
                <label>
                  Website
                  <input type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
                </label>
              </div>
              <div className="span-2">
                <Button variant="primary" type="submit" size="lg" block loading={book.busy}>
                  {price ? (page.approval === "auto" ? "Book it and continue to payment" : "Request this time and continue to payment") : page.approval === "auto" ? "Book it" : "Request this time"}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </PublicShell>
  );
}
