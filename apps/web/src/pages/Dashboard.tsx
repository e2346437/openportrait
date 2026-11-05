import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Icon, Panel, StatusChip } from "@openportrait/ui";
import { api, type HomeSummary } from "../lib/api.js";
import { focalPos, type GallerySummary } from "../lib/galleries.js";
import { formatMoney } from "../lib/money.js";
import { useSession } from "../lib/session.js";
import { tunnelSummary, useInternet } from "../lib/useInternet.js";
import { useLoad } from "../lib/useLoad.js";

const DAY = 86_400_000;

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "2 shoots this week, 3 inquiries waiting, and 1 gallery ready to share." Only the parts that apply. */
function summaryLine(h: HomeSummary): Array<{ n: number; text: string }> {
  const shoots = h.upcoming.filter((u) => u.source === "shoot").length;
  const parts: Array<{ n: number; text: string }> = [];
  if (shoots)
    parts.push({ n: shoots, text: `${plural(shoots, "shoot")} this week` });
  const inquiries = h.needs.find((n) => n.key === "inquiries")?.count ?? 0;
  if (inquiries)
    parts.push({
      n: inquiries,
      text: `${plural(inquiries, "inquiry", "inquiries")} waiting for a reply`,
    });
  if (h.pulse.galleriesToDeliver)
    parts.push({
      n: h.pulse.galleriesToDeliver,
      text: `${plural(h.pulse.galleriesToDeliver, "gallery", "galleries")} ready to share`,
    });
  if (h.pulse.overdueInvoices)
    parts.push({
      n: h.pulse.overdueInvoices,
      text: `${plural(h.pulse.overdueInvoices, "invoice")} overdue`,
    });
  return parts.slice(0, 3);
}

/** The band at the top: the newest gallery cover behind the greeting, or the brand's lens until there is one. */
function Hero({
  home,
  loading,
  studioName,
  firstName,
  tz,
  isOwner,
  fresh,
}: {
  home: HomeSummary | null;
  loading: boolean;
  studioName: string;
  firstName: string;
  tz?: string;
  isOwner: boolean;
  fresh: boolean;
}) {
  const today = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  }).format(Date.now());
  const parts = home ? summaryLine(home) : [];
  const [loaded, setLoaded] = useState(false);
  const photo = home?.hero ?? null;
  return (
    <section
      className={`hero${photo ? " has-photo" : ""}`}
      aria-busy={loading && !home}
    >
      {photo ? (
        <>
          <img
            className={`hero-photo${loaded ? " in" : ""}`}
            src={photo.preview}
            alt=""
            style={{ objectPosition: focalPos(photo.focalX, photo.focalY) }}
            onLoad={() => setLoaded(true)}
          />
          <Link
            to={`/studio/galleries/${photo.galleryId}`}
            className="hero-credit"
          >
            From “{photo.title}”
          </Link>
        </>
      ) : (
        <div className="hero-lens" aria-hidden="true" />
      )}
      <div className="hero-text">
        <span className="hero-eyebrow">
          {studioName} · {today}
        </span>
        <h1>
          {fresh ? "Welcome" : greeting()}
          {firstName ? `, ${firstName}` : ""}.
          {fresh ? (
            <>
              <br />
              Your studio is yours.
            </>
          ) : null}
        </h1>
        {fresh ? (
          <p className="hero-sub">
            Everything here runs on your own server. Start with the three steps
            below, and your first gallery will take this spot.
          </p>
        ) : parts.length ? (
          <p className="hero-sub">
            {parts.map((p, i) => (
              <span key={p.text}>
                {i > 0 ? (i === parts.length - 1 ? ", and " : ", ") : ""}
                <b>{p.text}</b>
              </span>
            ))}
            .
          </p>
        ) : home ? (
          <p className="hero-sub">
            Nothing is waiting on you. New inquiries show up under Leads.
          </p>
        ) : (
          <p className="hero-sub">&nbsp;</p>
        )}
      </div>
      {isOwner ? (
        <div className="hero-cta">
          {fresh ? (
            <Link to="/studio/settings/internet" className="btn primary">
              Start setup <Icon name="arrowRight" />
            </Link>
          ) : (
            <>
              <Link to="/studio/leads?new" className="btn">
                <Icon name="plus" /> Lead
              </Link>
              <Link to="/studio/shoots?new" className="btn">
                <Icon name="plus" /> Shoot
              </Link>
              <Link to="/studio/galleries" className="btn primary">
                Open galleries
              </Link>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Four numbers, no charts. Each tile opens its page. */
function Pulse({
  p,
  fresh,
}: {
  p: HomeSummary["pulse"] | null;
  fresh: boolean;
}) {
  const tiles: Array<{
    k: string;
    v: string;
    unit?: string;
    d: string;
    tone?: "ok" | "warn";
    to: string;
  }> = p
    ? [
        {
          k: "Open leads",
          v: String(p.openLeads),
          d: fresh
            ? "New inquiries land here"
            : p.newLeadsThisWeek
              ? `${plural(p.newLeadsThisWeek, "new inquiry", "new inquiries")} this week`
              : "No new inquiries this week",
          tone: p.newLeadsThisWeek ? "ok" : undefined,
          to: "/studio/leads",
        },
        {
          k: "Shoots this month",
          v: String(p.monthShoots),
          d: fresh
            ? "From your booking page"
            : p.monthBookedCents
              ? `${formatMoney(p.monthBookedCents)} invoiced`
              : p.monthShoots
                ? "Nothing invoiced yet"
                : "Nothing on the calendar",
          to: "/studio/calendar",
        },
        {
          k: "Outstanding",
          v: formatMoney(p.outstandingCents),
          d: fresh
            ? "Nothing owed to you"
            : p.outstandingInvoices
              ? `${plural(p.outstandingInvoices, "invoice")}${p.overdueInvoices ? ` · ${p.overdueInvoices} overdue` : ""}`
              : "Nothing owed to you",
          tone: p.overdueInvoices ? "warn" : undefined,
          to: "/studio/orders",
        },
        {
          k: "Galleries",
          v: String(p.galleriesToDeliver),
          unit: "to deliver",
          d: fresh
            ? "Your work, as clients see it"
            : p.galleriesDeliveredThisYear
              ? `${plural(p.galleriesDeliveredThisYear, "gallery", "galleries")} delivered this year`
              : "None delivered yet this year",
          to: "/studio/galleries",
        },
      ]
    : [];
  if (!p)
    return (
      <div className="pulse" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile skeleton" />
        ))}
      </div>
    );
  return (
    <div className="pulse">
      {tiles.map((t) => (
        <Link key={t.k} to={t.to} className="tile">
          <span className="tile-k">{t.k}</span>
          <span className="tile-v">
            {t.v}
            {t.unit ? <small>{t.unit}</small> : null}
          </span>
          <span className={`tile-d${t.tone ? ` ${t.tone}` : ""}`}>{t.d}</span>
        </Link>
      ))}
    </div>
  );
}

const READY_LABEL = {
  contract: {
    signed: "Contract signed",
    sent: "Contract unsigned",
    none: null,
  },
  deposit: { paid: "Deposit paid", due: "Payment due", none: null },
  questionnaire: {
    returned: "Questionnaire returned",
    sent: "Questionnaire out",
    none: null,
  },
} as const;

/** The next seven days, grouped by day. */
function UpNext({
  items,
  tz,
  loading,
}: {
  items: HomeSummary["upcoming"];
  tz?: string;
  loading: boolean;
}) {
  const dayKey = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    }).format(ms);
  const todayKey = dayKey(Date.now());
  const days = useMemo(() => {
    const map = new Map<string, HomeSummary["upcoming"]>();
    for (const i of items) {
      const k = dayKey(i.startsAt);
      map.set(k, [...(map.get(k) ?? []), i]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tz]);
  const time = (i: HomeSummary["upcoming"][number]) =>
    i.allDay
      ? "All day"
      : new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: tz,
        }).format(i.startsAt);
  const dateOf = (k: string) => {
    const [y, m, d] = k.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d, 12);
  };
  return (
    <Panel
      title="Up next"
      description="Shoots and appointments for the next seven days."
      actions={
        <Link to="/studio/calendar" className="panel-link">
          Calendar <Icon name="arrowRight" />
        </Link>
      }
    >
      {loading && !items.length ? (
        <div className="home-agenda" aria-busy="true">
          <div className="skeleton" style={{ height: 64 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </div>
      ) : days.length ? (
        <div className="home-agenda">
          {days.map(([k, list]) => (
            <div key={k} className={`hd${k === todayKey ? " today" : ""}`}>
              <div className="hd-date">
                <b>
                  {new Intl.DateTimeFormat(undefined, {
                    day: "numeric",
                    timeZone: "UTC",
                  }).format(dateOf(k))}
                </b>
                <span>
                  {k === todayKey
                    ? "Today"
                    : new Intl.DateTimeFormat(undefined, {
                        weekday: "short",
                        timeZone: "UTC",
                      }).format(dateOf(k))}
                </span>
              </div>
              <div className="hd-events">
                {list.map((i) => {
                  const r = i.readiness;
                  const bits = [
                    i.location,
                    r && READY_LABEL.contract[r.contract],
                    r && READY_LABEL.deposit[r.deposit],
                    r && READY_LABEL.questionnaire[r.questionnaire],
                  ].filter(Boolean) as string[];
                  const inner = (
                    <>
                      <span className="hev-text">
                        <b>
                          {i.source === "shoot"
                            ? i.contactName
                              ? `${i.contactName} · ${i.shootType ?? i.title}`
                              : i.title
                            : i.title}
                        </b>
                        <span>
                          {bits.length
                            ? bits.join(" · ")
                            : i.source === "shoot"
                              ? "No location yet"
                              : i.source === "block"
                                ? "Time blocked off"
                                : "Appointment"}
                        </span>
                      </span>
                      <span className="hev-time">{time(i)}</span>
                    </>
                  );
                  return i.shootId ? (
                    <Link
                      key={i.key}
                      to={`/studio/shoots/${i.shootId}`}
                      className={`hev ${i.source}`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <Link
                      key={i.key}
                      to="/studio/calendar"
                      className={`hev ${i.source}`}
                    >
                      {inner}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="home-empty">
          <b>Nothing booked this week.</b>
          <span>Shoots you add, and bookings clients make, show up here.</span>
        </div>
      )}
    </Panel>
  );
}

/** Everything waiting on the owner, oldest first. Rows disappear as they are handled. */
function NeedsYou({
  needs,
  loading,
}: {
  needs: HomeSummary["needs"];
  loading: boolean;
}) {
  return (
    <Panel
      title="Needs you"
      description={needs.length ? "Clears itself as you act." : undefined}
    >
      {loading && !needs.length ? (
        <div className="att" aria-busy="true">
          <div className="skeleton" style={{ height: 48 }} />
          <div className="skeleton" style={{ height: 48 }} />
        </div>
      ) : needs.length ? (
        <div className="att">
          {needs.map((n) => (
            <Link key={n.key} to={n.to} className="att-row">
              <span className={`att-count ${n.tone}`} aria-hidden="true">
                {n.count}
              </span>
              <span className="att-text">
                <b>{n.title}</b>
                <span>{n.detail}</span>
              </span>
              <span className="att-act">
                {n.action} <Icon name="arrowRight" />
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="home-empty">
          <span className="home-empty-mark" aria-hidden="true">
            <Icon name="check" />
          </span>
          <b>All clear.</b>
          <span>
            Inquiries, unpaid invoices, unsigned contracts and galleries ready
            to share will appear here.
          </span>
        </div>
      )}
    </Panel>
  );
}

/** The studio's latest work, with a status on each cover. */
function RecentGalleries({
  galleries,
  loading,
}: {
  galleries: GallerySummary[];
  loading: boolean;
}) {
  const recent = galleries
    .filter((g) => g.status !== "archived" && g.photoCount > 0)
    .slice(0, 5);
  const status = (g: GallerySummary) =>
    g.status === "live"
      ? { label: "Shared", cls: "" }
      : g.processing
        ? { label: "Processing", cls: " busy" }
        : { label: "Ready to share", cls: " ready" };
  return (
    <Panel
      title="Recent galleries"
      description="Your latest work, as clients see it."
      actions={
        <Link to="/studio/galleries" className="panel-link">
          All galleries <Icon name="arrowRight" />
        </Link>
      }
    >
      {loading && !galleries.length ? (
        <div className="strip" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="g skeleton" />
          ))}
        </div>
      ) : recent.length ? (
        <div className="strip">
          {recent.map((g) => {
            const s = status(g);
            return (
              <Link key={g.id} to={`/studio/galleries/${g.id}`} className="g">
                {g.cover ? (
                  <img
                    src={g.cover.thumb}
                    alt=""
                    loading="lazy"
                    style={{
                      objectPosition: focalPos(g.coverFocalX, g.coverFocalY),
                    }}
                  />
                ) : (
                  <span className="g-blank" aria-hidden="true">
                    <Icon name="image" />
                  </span>
                )}
                <span className={`g-status${s.cls}`}>{s.label}</span>
                <span className="g-cap">
                  <b>{g.title}</b>
                  <span>
                    {plural(g.photoCount, "photo")} ·{" "}
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                    }).format(g.publishedAt ?? g.updatedAt)}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="home-empty">
          <b>No galleries yet.</b>
          <span>
            Export from Lightroom or Aftershoot into your gallery folder and the
            gallery appears here, ready to share.
          </span>
        </div>
      )}
    </Panel>
  );
}

interface SetupItem {
  title: string;
  detail: string;
  done: boolean;
  to: string;
}

const HIDE_KEY = "op.home.setupHidden";

/** The setup checklist: full for a new studio, a progress ring with the next steps once it is under way, gone when complete. */
function Setup({ items, fresh }: { items: SetupItem[]; fresh: boolean }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const done = items.filter((i) => i.done).length;
  if (done === items.length || hidden) return null;
  const left = items.filter((i) => !i.done);
  if (fresh) {
    return (
      <Panel
        title="Get your studio ready"
        description={`${done} of ${items.length} done. Each step links to the right setting.`}
        flush
      >
        <div className="setup-full">
          {items.map((item) => (
            <Link
              key={item.title}
              to={item.to}
              className={`setup-row${item.done ? " done" : ""}`}
            >
              <span className="tick" aria-hidden="true">
                {item.done ? <Icon name="check" /> : null}
              </span>
              <span>
                <b>{item.title}</b>
                <span>{item.detail}</span>
              </span>
              {item.done ? (
                <span className="setup-done">Done</span>
              ) : (
                <span className="btn sm">Set up</span>
              )}
            </Link>
          ))}
        </div>
      </Panel>
    );
  }
  const pct = Math.round((done / items.length) * 100);
  return (
    <section className="panel setup-compact">
      <span
        className="ring"
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        role="img"
        aria-label={`${done} of ${items.length} setup steps done`}
      >
        <i>
          {done}/{items.length}
        </i>
      </span>
      <div className="setup-text">
        <h2>Get your studio ready</h2>
        <p>
          {left.length === 1
            ? "One thing left."
            : `${left.length} things left.`}{" "}
          Each takes a few minutes.
        </p>
        <div className="setup-next">
          {left.slice(0, 2).map((i) => (
            <Link key={i.title} to={i.to} className="btn sm">
              {i.title}
            </Link>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(HIDE_KEY, "1");
          } catch {
            /* fine */
          }
        }}
      >
        Hide
      </button>
    </section>
  );
}

/** The three things that make the product useful fastest, for a studio with nothing in it yet. */
function FirstSteps({
  online,
  gallery,
  booking,
}: {
  online: boolean;
  gallery: boolean;
  booking: boolean;
}) {
  const steps: Array<{
    n: number;
    title: string;
    body: string;
    cta: string;
    to: string;
    done: boolean;
  }> = [
    {
      n: 1,
      title: "Put your studio online",
      body: "Connect a Cloudflare Tunnel so clients can open booking pages and galleries from anywhere.",
      cta: "Connect",
      to: "/studio/settings/internet",
      done: online,
    },
    {
      n: 2,
      title: "Deliver your first gallery",
      body: "Export from Lightroom or Aftershoot into your gallery folder and it appears here, ready to share.",
      cta: "Show me the folder",
      to: "/studio/settings/galleries",
      done: gallery,
    },
    {
      n: 3,
      title: "Open your booking page",
      body: "Pick your shoot types and prices. Clients book and pay the deposit without the back and forth.",
      cta: "Set up booking",
      to: "/studio/booking",
      done: booking,
    },
  ];
  return (
    <div className="firsts">
      {steps.map((s) => (
        <div key={s.n} className={`first${s.done ? " done" : ""}`}>
          <span className="first-n" aria-hidden="true">
            {s.done ? <Icon name="check" /> : s.n}
          </span>
          <b>{s.title}</b>
          <p>{s.body}</p>
          <Link to={s.to} className="btn sm">
            {s.done ? "Open" : s.cta} <Icon name="arrowRight" />
          </Link>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { me } = useSession();
  const isOwner = me?.user?.role === "owner";
  const tz = me?.studio.timezone || undefined;
  const firstName = me?.user?.name.split(/\s+/)[0] ?? "";
  const { status } = useInternet(isOwner ? 10_000 : 0);
  const online = status?.tunnel.state === "connected";
  const net = tunnelSummary(status);

  const home = useLoad<HomeSummary>(isOwner ? "/home" : null);
  const galleries = useLoad<{ galleries: GallerySummary[] }>("/galleries");
  // Each setup row reads the same state its settings page does. A failed read just leaves the row open.
  const google = useLoad<{ connected: boolean; lastSyncAt: number | null }>(
    isOwner ? "/google" : null,
  ).data;
  const paypal = useLoad<{ configured: boolean }>(
    isOwner ? "/payments/paypal" : null,
  ).data;
  const email = useLoad<{ configured: boolean }>(
    isOwner ? "/email" : null,
  ).data;
  const mfa = useLoad<{ enabled: boolean }>(isOwner ? "/auth/mfa" : null).data;
  const booking = useLoad<{ items: unknown[] }>(
    isOwner ? "/schedulers" : null,
  ).data;
  const [backupAt, setBackupAt] = useState<number | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    api<{ status: { lastAt: number | null } }>("/backups").then(
      (r) => setBackupAt(r.status.lastAt),
      () => undefined,
    );
  }, [isOwner]);

  const list = galleries.data?.galleries ?? [];
  const delivered = list.some((g) => g.photoCount > 0);
  const items: SetupItem[] = [
    {
      title: "Name your studio",
      detail: "Shown to clients on booking pages, galleries, and emails.",
      done: true,
      to: "/studio/settings/studio",
    },
    {
      title: "Put your studio online",
      detail: online
        ? `Clients reach you at ${status?.publicUrl || "your tunnel address"}.`
        : "Connect a Cloudflare Tunnel so clients can open booking pages and galleries.",
      done: online,
      to: "/studio/settings/internet",
    },
    {
      title: "Set up email",
      detail:
        "Send booking confirmations, quotes, contracts and questionnaires from your own address.",
      done: !!email?.configured,
      to: "/studio/settings/email",
    },
    {
      title: "Connect Google Calendar",
      detail: "Two-way sync for shoots and appointments.",
      done: !!google?.connected,
      to: "/studio/settings/calendar",
    },
    {
      title: "Set up PayPal",
      detail: "Take deposits and invoice payments online.",
      done: !!paypal?.configured,
      to: "/studio/settings/payments",
    },
    {
      title: "Turn on two-step sign-in",
      detail: "Protect your studio with a code from an authenticator app.",
      done: !!mfa?.enabled,
      to: "/studio/settings/account",
    },
    {
      title: "Deliver your first gallery",
      detail:
        "Exports from Lightroom or Aftershoot that land in your gallery folder show up here automatically.",
      done: delivered,
      to: "/studio/settings/galleries",
    },
  ];
  const setupDone = items.filter((i) => i.done).length;
  // A studio with no work in it yet gets the welcome layout. Three setup steps or any real data switches to the working one.
  const h = home.data;
  const fresh =
    !!isOwner &&
    !!h &&
    setupDone < 3 &&
    h.pulse.openLeads === 0 &&
    h.upcoming.length === 0 &&
    !delivered &&
    h.pulse.monthShoots === 0;
  const since = (ms: number) => {
    const d = Math.floor((Date.now() - ms) / DAY);
    if (d < 1)
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz,
      }).format(ms);
    return d === 1 ? "yesterday" : `${d} days ago`;
  };

  return (
    <div className="home">
      <Hero
        home={h}
        loading={home.loading}
        studioName={me?.studio.name ?? ""}
        firstName={firstName}
        tz={tz}
        isOwner={!!isOwner}
        fresh={fresh}
      />

      {isOwner && home.error ? (
        <div className="home-error" role="alert">
          <Icon name="alert" /> Couldn't load the studio summary. {home.error}{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => void home.reload()}
          >
            Try again
          </button>
        </div>
      ) : null}

      {isOwner && fresh ? (
        <FirstSteps
          online={online}
          gallery={delivered}
          booking={(booking?.items?.length ?? 0) > 0}
        />
      ) : null}

      {isOwner ? <Pulse p={h?.pulse ?? null} fresh={fresh} /> : null}

      {fresh ? null : (
        <div className={`home-cols${isOwner ? "" : " one"}`}>
          <UpNext items={h?.upcoming ?? []} tz={tz} loading={home.loading} />
          {isOwner ? (
            <NeedsYou needs={h?.needs ?? []} loading={home.loading} />
          ) : null}
        </div>
      )}

      {fresh ? null : (
        <RecentGalleries galleries={list} loading={galleries.loading} />
      )}

      {isOwner ? <Setup items={items} fresh={fresh} /> : null}

      {isOwner ? (
        <div className="home-status">
          <StatusChip tone={net.tone} pulse={net.tone === "info"}>
            {online && status?.publicUrl
              ? `Online at ${status.publicUrl.replace(/^https?:\/\//, "")}`
              : net.label}
          </StatusChip>
          {google?.connected ? (
            <StatusChip tone="ok">
              {google.lastSyncAt
                ? `Google Calendar synced ${since(google.lastSyncAt)}`
                : "Google Calendar connected"}
            </StatusChip>
          ) : null}
          <StatusChip tone={backupAt ? "neutral" : "warn"}>
            {backupAt ? `Last backup ${since(backupAt)}` : "No backup yet"}
          </StatusChip>
          <span className="home-status-spacer" />
          {me?.build ? (
            <Link
              to="/studio/settings/account"
              className="home-version"
              title="About this version"
            >
              v{me.build.version}
              {me.build.commit ? ` · ${me.build.commit}` : ""}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
