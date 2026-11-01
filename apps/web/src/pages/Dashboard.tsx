import { Link } from "react-router";
import { Icon, Panel, StatusChip } from "@openportrait/ui";
import { useSession } from "../lib/session.js";
import { tunnelSummary, useInternet } from "../lib/useInternet.js";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

interface Item {
  title: string;
  detail: string;
  done: boolean;
  to?: string;
  later?: string;
}

export function DashboardPage() {
  const { me } = useSession();
  const isOwner = me?.user?.role === "owner";
  const { status } = useInternet(isOwner ? 10_000 : 0);
  const online = status?.tunnel.state === "connected";
  const summary = tunnelSummary(status);
  const firstName = me?.user?.name.split(/\s+/)[0] ?? "";

  const items: Item[] = [
    { title: "Name your studio", detail: "Shown to clients on booking pages, galleries, and emails.", done: true, to: "/studio/settings/studio" },
    {
      title: "Put your studio online",
      detail: online ? `Clients reach you at ${status?.publicUrl || "your tunnel address"}.` : "Connect a Cloudflare Tunnel so clients can open booking pages and galleries.",
      done: online,
      to: "/studio/settings/internet",
    },
    { title: "Connect Google Calendar", detail: "Two-way sync for shoots and appointments.", done: false, later: "Coming soon" },
    { title: "Set up PayPal", detail: "Take deposits and invoice payments online.", done: false, later: "Coming soon" },
    { title: "Point OpenPortrait at your gallery share", detail: "Exports from Lightroom or Aftershoot appear in galleries automatically.", done: false, later: "Coming soon" },
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

      <Panel
        title="Get your studio ready"
        description={`${doneCount} of ${items.length} done. The rest unlock as OpenPortrait grows.`}
        actions={isOwner ? <StatusChip tone={summary.tone} pulse={summary.tone === "info"}>{summary.label}</StatusChip> : undefined}
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
                {item.later ? (
                  <StatusChip>{item.later}</StatusChip>
                ) : item.done ? (
                  <span className="sr-only">Done</span>
                ) : (
                  <span className="btn sm">
                    Set up <Icon name="arrowRight" />
                  </span>
                )}
              </>
            );
            const cls = `check-row${item.done ? " done" : ""}${item.later ? " later" : ""}`;
            return item.to && !item.later ? (
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
    </>
  );
}
