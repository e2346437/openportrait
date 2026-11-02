import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Callout, EmptyState, PageHeader, Spinner, StatusChip, TextInput } from "@openportrait/ui";
import { useSession } from "../../lib/session.js";
import { formatDate, ms } from "../../lib/time.js";
import { useDebounced, useLoad } from "../../lib/useLoad.js";
import { formatMoney, stateLabel, stateTone, type OrderSummary } from "../../lib/money.js";

const filters = [
  ["all", "All"],
  ["quote", "Quotes"],
  ["invoice", "Invoices"],
  ["owing", "Owing"],
] as const;

export function OrdersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const [filter, setFilter] = useState<(typeof filters)[number][0]>("all");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const kind = filter === "quote" || filter === "invoice" ? `&kind=${filter}` : "";
  const { data, error, loading } = useLoad<{ items: OrderSummary[] }>(`/orders?q=${encodeURIComponent(term)}${kind}`);
  const money = useLoad<{ currency: string }>("/money/settings");
  const currency = money.data?.currency ?? "USD";
  const items = (data?.items ?? []).filter((o) => filter !== "owing" || (o.kind === "invoice" && (o.state === "unpaid" || o.state === "partial")));
  const owed = items.filter((o) => o.kind === "invoice" && (o.state === "unpaid" || o.state === "partial")).reduce((n, o) => n + o.balanceCents, 0);
  const contact = params.get("contact");
  void setParams;

  return (
    <>
      <PageHeader
        title="Orders"
        description="Quotes and invoices. When a client accepts a quote it becomes their invoice."
        actions={
          <>
            <Button icon="plus" variant="primary" onClick={() => navigate(`/studio/orders/new${contact ? `?contact=${contact}` : ""}`)}>
              New quote
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Show">
          {filters.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="grow-search">
          <TextInput type="search" placeholder="Search by title or client" aria-label="Search orders" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {owed > 0 ? <p className="muted owed-note">{formatMoney(owed, currency)} still owed across {items.filter((o) => o.balanceCents > 0 && o.kind === "invoice").length} invoices.</p> : null}
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {loading && !data ? <Spinner label="Loading" /> : null}
      {data && items.length === 0 ? (
        <EmptyState icon="receipt" title={term || filter !== "all" ? "Nothing matches" : "No quotes or invoices yet"} action={!term && filter === "all" ? <Button variant="primary" icon="plus" onClick={() => navigate("/studio/orders/new")}>Write your first quote</Button> : undefined}>
          {term || filter !== "all" ? "Try a different search or filter." : "A quote lists what you'll do and what it costs. The client accepts it online, and it becomes their invoice."}
        </EmptyState>
      ) : null}
      {items.length ? (
        <ul className="order-list">
          {items.map((o) => (
            <li key={o.id}>
              <Link to={`/studio/orders/${o.id}`} className="order-row">
                <span className="order-main">
                  <b>{o.title}</b>
                  <small>
                    {o.label} · {o.contactName} · {formatDate(ms(o.createdAt), tz, { month: "short", day: "numeric", year: "numeric" })}
                  </small>
                </span>
                <StatusChip tone={stateTone(o.state)}>{stateLabel[o.state]}</StatusChip>
                <span className="order-amt">
                  <b>{formatMoney(o.totalCents, currency)}</b>
                  {o.kind === "invoice" && o.balanceCents > 0 && o.paidCents > 0 ? <small>{formatMoney(o.balanceCents, currency)} due</small> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
