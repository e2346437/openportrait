import { Link } from "react-router";
import { Icon, Panel } from "@openportrait/ui";
import type { GallerySummary } from "../lib/galleries.js";
import { formatMoney, type OrderSummary } from "../lib/money.js";
import { useLoad } from "../lib/useLoad.js";
import { useSession } from "../lib/session.js";

interface UpcomingShoot {
  id: string;
  subject: string;
  shootType: string;
  client: string;
  startsAt: number | null;
  location: string | null;
}

interface Row {
  key: string;
  to: string;
  title: string;
  detail: string;
  action: string;
  icon: "calendar" | "image" | "inbox" | "receipt";
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** What is on the plate this week: the next shoots, then anything waiting on the studio. Hidden rows mean nothing is waiting. */
export function ThisWeek() {
  const { me } = useSession();
  const tz = me?.studio.timezone || undefined;
  const shoots = useLoad<{ items: UpcomingShoot[] }>(
    "/shoots?when=upcoming&status=active&limit=3",
  );
  const galleries = useLoad<{ galleries: GallerySummary[] }>("/galleries");
  const incoming = useLoad<{ total: number }>("/incoming");
  const orders = useLoad<{ items: OrderSummary[] }>("/orders?kind=invoice");

  const loading = [shoots, galleries, incoming, orders].every(
    (r) => r.loading && !r.data,
  );
  const rows: Row[] = [];

  for (const s of shoots.data?.items ?? []) {
    const when = s.startsAt
      ? new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: tz,
        }).format(s.startsAt)
      : "No date yet";
    rows.push({
      key: `shoot-${s.id}`,
      to: `/studio/shoots/${s.id}`,
      title: `${s.client} · ${s.shootType}`,
      detail: s.location ? `${when} · ${s.location}` : when,
      action: "Open",
      icon: "calendar",
    });
  }

  const ready = (galleries.data?.galleries ?? []).filter(
    (g) => g.status === "draft" && g.photoCount > 0 && g.processing === 0,
  );
  if (ready.length)
    rows.push({
      key: "galleries",
      to: "/studio/galleries",
      title: `${plural(ready.length, "gallery", "galleries")} waiting to be shared`,
      detail:
        ready.length === 1
          ? ready[0]!.title
          : `${ready[0]!.title} and ${ready.length - 1} more`,
      action: "Review",
      icon: "image",
    });

  const photos = incoming.data?.total ?? 0;
  if (photos)
    rows.push({
      key: "incoming",
      to: "/studio/incoming",
      title: `${plural(photos, "photo")} waiting in Incoming`,
      detail: "Sort them into a shoot so they reach a gallery.",
      action: "Sort",
      icon: "inbox",
    });

  const owed = (orders.data?.items ?? []).filter(
    (o) => o.state === "unpaid" || o.state === "partial",
  );
  if (owed.length) {
    const total = owed.reduce((n, o) => n + o.balanceCents, 0);
    rows.push({
      key: "invoices",
      to: "/studio/orders",
      title: `${plural(owed.length, "unpaid invoice")}`,
      detail: `${formatMoney(total)} outstanding`,
      action: "View",
      icon: "receipt",
    });
  }

  if (loading) return null;
  return (
    <Panel
      title="This week"
      description={
        rows.length
          ? "Your next shoots and anything waiting on you."
          : undefined
      }
    >
      {rows.length ? (
        <div className="checklist" style={{ margin: "calc(var(--s5) * -1)" }}>
          {rows.map((r) => (
            <Link key={r.key} to={r.to} className="check-row info">
              <span className="tick" aria-hidden="true">
                <Icon name={r.icon} />
              </span>
              <span>
                <b>{r.title}</b>
                <span>{r.detail}</span>
              </span>
              <span className="btn sm">
                {r.action} <Icon name="arrowRight" />
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="hint">
          Nothing booked or waiting this week. New inquiries show up under
          Leads.
        </p>
      )}
    </Panel>
  );
}
