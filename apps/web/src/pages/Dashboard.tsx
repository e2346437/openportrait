import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Icon, Panel, StatusChip } from "@openportrait/ui";
import { api, type Reminder } from "../lib/api.js";
import { useSession } from "../lib/session.js";
import { tunnelSummary, useInternet } from "../lib/useInternet.js";
import { ThisWeek } from "../components/ThisWeek.js";
import { useLoad } from "../lib/useLoad.js";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

interface Item {
  title: string;
  detail: string;
  done: boolean;
  to?: string;
}

const REMINDER_PATH = {
  lead: "leads",
  shoot: "shoots",
  contact: "clients",
} as const;

const waited = (since: number) => {
  const d = Math.floor((Date.now() - since) / 86_400_000);
  return d < 1 ? "today" : d === 1 ? "1 day" : `${d} days`;
};

/** Built-in reminders: leads that need a reply or follow-up and shoots that need preparing. Owner only; nothing is sent for you. */
function Reminders() {
  const [items, setItems] = useState<Reminder[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ items: Reminder[] }>("/automation/reminders")
      .then((r) => live && setItems(r.items))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, []);
  if (!items?.length) return null;
  return (
    <Panel
      title="Needs your attention"
      description={`${items.length} ${items.length === 1 ? "thing" : "things"} waiting. They clear themselves once you act.`}
    >
      <div className="checklist" style={{ margin: "calc(var(--s5) * -1)" }}>
        {items.map((r) => (
          <Link
            key={r.id}
            to={`/studio/${REMINDER_PATH[r.ref.type]}/${r.ref.id}`}
            className="check-row"
          >
            <span className="tick" aria-hidden="true" />
            <span>
              <b>{r.title}</b>
              <span>{r.detail}</span>
            </span>
            <span className="btn sm">
              Open <Icon name="arrowRight" />
            </span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

export function DashboardPage() {
  const { me } = useSession();
  const isOwner = me?.user?.role === "owner";
  const { status } = useInternet(isOwner ? 10_000 : 0);
  const online = status?.tunnel.state === "connected";
  const summary = tunnelSummary(status);
  const firstName = me?.user?.name.split(/\s+/)[0] ?? "";
  // Each row reads the same state its settings page does. A failed read just leaves the row open.
  const google = useLoad<{ connected: boolean }>(
    isOwner ? "/google" : null,
  ).data;
  const paypal = useLoad<{ configured: boolean }>(
    isOwner ? "/payments/paypal" : null,
  ).data;
  const email = useLoad<{ configured: boolean }>(
    isOwner ? "/email" : null,
  ).data;
  const mfa = useLoad<{ enabled: boolean }>(isOwner ? "/auth/mfa" : null).data;
  const galleries = useLoad<{ galleries: Array<{ photoCount: number }> }>(
    isOwner ? "/galleries" : null,
  ).data;

  const items: Item[] = [
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
      title: "Connect Google Calendar",
      detail: "Two-way sync for shoots and appointments.",
      done: !!google?.connected,
      to: "/studio/settings/calendar",
    },
    {
      title: "Set up email",
      detail:
        "Send booking confirmations, quotes, contracts and questionnaires from your own address.",
      done: !!email?.configured,
      to: "/studio/settings/email",
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
      done: (galleries?.galleries ?? []).some((g) => g.photoCount > 0),
      to: "/studio/settings/galleries",
    },
  ];
  const doneCount = items.filter((i) => i.done).length;

  return (
    <>
      <div className="hello">
        <span className="eyebrow">{me?.studio.name}</span>
        <h1>
          {greeting()}
          {firstName ? `, ${firstName}` : ""}.
        </h1>
      </div>

      {isOwner ? <Reminders /> : null}

      <ThisWeek />

      {isOwner ? (
        <Panel
          title="Get your studio ready"
          description={`${doneCount} of ${items.length} done.`}
          actions={
            isOwner ? (
              <StatusChip tone={summary.tone} pulse={summary.tone === "info"}>
                {summary.label}
              </StatusChip>
            ) : undefined
          }
        >
          <div className="checklist" style={{ margin: "calc(var(--s5) * -1)" }}>
            {items.map((item) => {
              const content = (
                <>
                  <span className="tick" aria-hidden="true">
                    {item.done ? <Icon name="check" /> : null}
                  </span>
                  <span>
                    <b>{item.title}</b>
                    <span>{item.detail}</span>
                  </span>
                  {item.done ? (
                    <span className="sr-only">Done</span>
                  ) : (
                    <span className="btn sm">
                      Set up <Icon name="arrowRight" />
                    </span>
                  )}
                </>
              );
              const cls = `check-row${item.done ? " done" : ""}`;
              return item.to ? (
                <Link key={item.title} to={item.to} className={cls}>
                  {content}
                </Link>
              ) : (
                <div key={item.title} className={cls}>
                  {content}
                </div>
              );
            })}
          </div>
        </Panel>
      ) : null}
    </>
  );
}
