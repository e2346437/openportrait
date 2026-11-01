import { useState } from "react";
import { Link } from "react-router";
import { Button, Callout, CopyValue, EmptyState, Field, PageHeader, Panel, Spinner, StatusChip, TextArea, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDateTime } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { SchedulerDialog, type Scheduler } from "./SchedulerDialog.js";

interface Booking {
  id: string;
  status: "pending" | "confirmed" | "declined" | "cancelled";
  startsAt: string | number;
  message: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  contactId: string;
  schedulerName: string;
}
interface Inquiry {
  enabled: boolean;
  intro: string;
  thanks: string;
  notify: boolean;
  introDefault: string;
  thanksDefault: string;
  pageUrl: string;
}

const ms = (v: string | number) => new Date(v).getTime();
const tabs = [
  ["requests", "Requests"],
  ["pages", "Booking pages"],
  ["form", "Inquiry form"],
] as const;

export function BookingPage() {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("requests");
  const pending = useLoad<{ items: Booking[] }>("/bookings?status=pending");
  const count = pending.data?.items.length ?? 0;
  return (
    <>
      <PageHeader title="Booking" description="Let clients ask for a time or send an inquiry from your website." />
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
            {k === "requests" && count ? <span className="count-pill">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "requests" ? <Requests pending={pending} /> : tab === "pages" ? <Pages /> : <InquiryForm />}
      </div>
    </>
  );
}

function Requests({ pending }: { pending: ReturnType<typeof useLoad<{ items: Booking[] }>> }) {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const toast = useToast();
  const upcoming = useLoad<{ items: Booking[] }>("/bookings?status=confirmed&upcoming=true");
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const act = useSubmit(async () => undefined as unknown);

  const run = async (id: string, what: "confirm" | "decline" | "cancel", body?: object) => {
    try {
      await api(`/bookings/${id}/${what}`, { method: "POST", body: body ?? {} });
      toast(what === "confirm" ? "Confirmed. The client has been emailed." : what === "decline" ? "Declined. The client has been emailed." : "Cancelled");
      setDeclining(null);
      setReason("");
      pending.reload();
      upcoming.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  void act;

  if (pending.loading && !pending.data) return <Spinner label="Loading" />;
  if (pending.error) return <Callout tone="bad">{pending.error}</Callout>;
  const items = pending.data?.items ?? [];

  return (
    <div className="stack">
      <Panel title="Waiting for you" description="Times are held on your calendar until you answer." flush>
        {items.length === 0 ? (
          <EmptyState icon="check" title="No requests waiting">New booking requests show up here and in your calendar.</EmptyState>
        ) : (
          <ul className="req-list">
            {items.map((b) => (
              <li key={b.id}>
                <div className="req-main">
                  <b>
                    <Link to={`/studio/clients/${b.contactId}`}>{b.name}</Link>
                  </b>
                  <span>
                    {b.schedulerName} · {formatDateTime(ms(b.startsAt), tz)}
                  </span>
                  {b.email ? <small>{b.email}{b.phone ? ` · ${b.phone}` : ""}</small> : null}
                  {b.message ? <p className="req-msg">{b.message}</p> : null}
                  {declining === b.id ? (
                    <div className="req-decline">
                      <Field label="Note to the client" hint="Optional. It's included in the email.">
                        {(p) => <TextArea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
                      </Field>
                      <div className="form-actions">
                        <Button variant="primary" onClick={() => run(b.id, "decline", { reason })}>Decline and email</Button>
                        <Button variant="ghost" onClick={() => setDeclining(null)}>Never mind</Button>
                      </div>
                    </div>
                  ) : null}
                </div>
                {declining === b.id ? null : (
                  <div className="controls">
                    <Button variant="primary" size="sm" onClick={() => run(b.id, "confirm")}>Confirm</Button>
                    <Button size="sm" onClick={() => { setDeclining(b.id); setReason(""); }}>Decline</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Upcoming bookings" flush>
        {!upcoming.data?.items.length ? (
          <EmptyState icon="calendar" title="Nothing booked yet">Confirmed bookings appear here.</EmptyState>
        ) : (
          <ul className="req-list">
            {upcoming.data.items.map((b) => (
              <li key={b.id}>
                <div className="req-main">
                  <b>
                    <Link to={`/studio/clients/${b.contactId}`}>{b.name}</Link>
                  </b>
                  <span>
                    {b.schedulerName} · {formatDateTime(ms(b.startsAt), tz)}
                  </span>
                </div>
                <div className="controls">
                  <Button variant="ghost" size="sm" className="danger" onClick={() => window.confirm(`Cancel ${b.name}'s booking? They'll be emailed.`) && run(b.id, "cancel")}>
                    Cancel
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Pages() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ items: Scheduler[] }>("/schedulers");
  const [editing, setEditing] = useState<Scheduler | "new" | null>(null);
  const base = window.location.origin;

  const toggle = async (s: Scheduler, active: boolean) => {
    try {
      await api(`/schedulers/${s.id}`, { method: "PATCH", body: { ...s, active } });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.");
    }
  };

  if (loading && !data) return <Spinner label="Loading" />;
  if (error) return <Callout tone="bad">{error}</Callout>;
  const items = data?.items ?? [];

  return (
    <div className="stack">
      <Panel
        title="Booking pages"
        description="Each page has its own link, length and weekly hours. Share the link or put it on your website."
        actions={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New page</Button> : null}
        flush
      >
        {items.length === 0 ? (
          <EmptyState icon="calendar" title="No booking pages yet" action={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Create your first</Button> : undefined}>
            A booking page lets clients pick an open time for a consult, a mini session, or anything else you offer.
          </EmptyState>
        ) : (
          <ul className="sched-list">
            {items.map((s) => (
              <li key={s.id}>
                <div className="sched-head">
                  <div>
                    <b>{s.name}</b>
                    <span>
                      {s.durationMinutes} min · {s.approval === "auto" ? "Books instantly" : "You confirm each request"}
                    </span>
                  </div>
                  <StatusChip tone={s.active ? "ok" : "neutral"}>{s.active ? "Live" : "Off"}</StatusChip>
                </div>
                <CopyValue value={`${base}/book/${s.slug}`} label="Booking link" />
                {owner ? (
                  <div className="sched-actions">
                    <SwitchRow checked={s.active} onChange={(v) => toggle(s, v)} label="Accepting bookings" />
                    <Button size="sm" icon="edit" onClick={() => setEditing(s)}>Edit</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <SchedulerDialog target={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); toast("Saved"); }} />
    </div>
  );
}

function InquiryForm() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Inquiry>("/inquiry");
  const [intro, setIntro] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const save = useSubmit((): Promise<Inquiry> => api("/inquiry", { method: "PUT", body: { intro: intro ?? data?.intro, thanks: thanks ?? data?.thanks } }));
  const flip = async (body: object) => {
    try {
      await api("/inquiry", { method: "PUT", body });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.");
    }
  };

  if (loading && !data) return <Spinner label="Loading" />;
  if (error || !data) return <Callout tone="bad">{error ?? "Couldn't load."}</Callout>;
  const pageUrl = data.pageUrl.startsWith("/") ? window.location.origin + data.pageUrl : data.pageUrl;
  const embed = `<iframe src="${pageUrl}?embed=1" title="Contact form" style="width:100%;border:0;min-height:640px" loading="lazy"></iframe>`;

  return (
    <div className="stack">
      <Panel
        title="Inquiry form"
        description="A simple contact form. Each message becomes a lead with the person added to your clients."
        actions={<StatusChip tone={data.enabled ? "ok" : "neutral"}>{data.enabled ? "Live" : "Off"}</StatusChip>}
      >
        <CopyValue value={data.pageUrl.startsWith("/") ? window.location.origin + data.pageUrl : data.pageUrl} label="Form link" />
        {owner ? (
          <>
            <SwitchRow checked={data.enabled} onChange={(v) => flip({ enabled: v })} label="Accept inquiries" />
            <SwitchRow checked={data.notify} onChange={(v) => flip({ notify: v })} label="Email me when one arrives" />
            <form
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await save.submit()) {
                  toast("Saved");
                  setIntro(null);
                  setThanks(null);
                  reload();
                }
              }}
            >
              <Field className="span-2" label="Introduction" hint="Shown above the form.">
                {(p) => <TextArea {...p} rows={2} maxLength={1000} placeholder={data.introDefault} value={intro ?? data.intro} onChange={(e) => setIntro(e.target.value)} />}
              </Field>
              <Field className="span-2" label="Thank-you message" hint="Shown after someone sends the form.">
                {(p) => <TextArea {...p} rows={2} maxLength={1000} placeholder={data.thanksDefault} value={thanks ?? data.thanks} onChange={(e) => setThanks(e.target.value)} />}
              </Field>
              {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
              <div className="span-2 form-actions">
                <Button variant="primary" type="submit" loading={save.busy} disabled={intro === null && thanks === null}>Save</Button>
              </div>
            </form>
          </>
        ) : null}
      </Panel>
      <Panel title="Put it on your website" description="Paste this where you want the form to appear.">
        <pre className="snippet">{embed}</pre>
        <p className="muted" style={{ margin: 0 }}>
          You can also embed a booking page the same way: add <code>?embed=1</code> to its link.
        </p>
      </Panel>
    </div>
  );
}
