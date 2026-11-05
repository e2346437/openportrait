import { Link } from "react-router";
import { Panel, StatusChip } from "@openportrait/ui";
import {
  contractLabel,
  contractTone,
  type ContractSummary,
} from "../lib/contracts.js";
import type { GallerySummary } from "../lib/galleries.js";
import {
  formatMoney,
  stateLabel,
  stateTone,
  type OrderSummary,
} from "../lib/money.js";
import { useLoad } from "../lib/useLoad.js";

const GALLERY_STATE = {
  draft: { label: "Not shared", tone: "neutral" },
  live: { label: "Shared", tone: "ok" },
  archived: { label: "Archived", tone: "neutral" },
} as const;

function Empty({ children }: { children: string }) {
  return (
    <p className="hint" style={{ padding: "var(--s4) var(--s5)" }}>
      {children}
    </p>
  );
}

/** Quotes and invoices for a shoot or a client, with the balance still owed. */
export function OrdersPanel({
  shootId,
  contactId,
}: {
  shootId?: string;
  contactId?: string;
}) {
  const query = shootId ? `shootId=${shootId}` : `contactId=${contactId}`;
  const { data, error } = useLoad<{ items: OrderSummary[] }>(
    `/orders?${query}`,
  );
  const items = (data?.items ?? []).filter((o) => o.state !== "void");
  const newTo = shootId
    ? `/studio/orders/new?shoot=${shootId}`
    : `/studio/orders/new?contact=${contactId}`;
  return (
    <Panel
      flush
      title="Quotes and invoices"
      actions={
        <Link className="btn sm" to={newTo}>
          New quote
        </Link>
      }
    >
      {error ? (
        <Empty>Couldn't load these.</Empty>
      ) : !data ? (
        <div
          className="skeleton"
          style={{ height: 56, margin: "var(--s4) var(--s5)" }}
        />
      ) : items.length === 0 ? (
        <Empty>Nothing written yet.</Empty>
      ) : (
        <div className="rows">
          {items.map((o) => (
            <Link key={o.id} to={`/studio/orders/${o.id}`} className="row">
              <span className="grow">
                <b>{o.title || o.label}</b>
                <span>
                  {o.label} · {formatMoney(o.totalCents)}
                  {o.kind === "invoice" &&
                  o.balanceCents > 0 &&
                  o.state !== "draft"
                    ? ` · ${formatMoney(o.balanceCents)} owed`
                    : ""}
                </span>
              </span>
              <StatusChip tone={stateTone(o.state)}>
                {stateLabel[o.state]}
              </StatusChip>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Contracts for a shoot or a client and whether they've been signed. */
export function ContractsPanel({
  shootId,
  contactId,
}: {
  shootId?: string;
  contactId: string;
}) {
  const { data, error } = useLoad<{ items: ContractSummary[] }>(
    `/contracts?${shootId ? `shootId=${shootId}` : `contactId=${contactId}`}`,
  );
  const items = (data?.items ?? []).filter((c) => c.state !== "void");
  return (
    <Panel
      flush
      title="Contracts"
      actions={
        <Link className="btn sm" to={`/studio/contracts?contact=${contactId}`}>
          New contract
        </Link>
      }
    >
      {error ? (
        <Empty>Couldn't load these.</Empty>
      ) : !data ? (
        <div
          className="skeleton"
          style={{ height: 56, margin: "var(--s4) var(--s5)" }}
        />
      ) : items.length === 0 ? (
        <Empty>No contract yet.</Empty>
      ) : (
        <div className="rows">
          {items.map((c) => (
            <Link key={c.id} to={`/studio/contracts/${c.id}`} className="row">
              <span className="grow">
                <b>{c.title}</b>
                <span>{c.contactName}</span>
              </span>
              <StatusChip tone={contractTone(c.state)}>
                {contractLabel[c.state]}
              </StatusChip>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Galleries made from a shoot, or from any of a client's shoots. */
export function GalleriesPanel({ shootIds }: { shootIds: string[] }) {
  const { data, error } = useLoad<{ galleries: GallerySummary[] }>(
    "/galleries",
  );
  const items = (data?.galleries ?? []).filter(
    (g) => g.shootId && shootIds.includes(g.shootId),
  );
  return (
    <Panel flush title="Galleries">
      {error ? (
        <Empty>Couldn't load these.</Empty>
      ) : !data ? (
        <div
          className="skeleton"
          style={{ height: 56, margin: "var(--s4) var(--s5)" }}
        />
      ) : items.length === 0 ? (
        <Empty>
          No gallery yet. One appears once photos are exported into the shoot's
          folder.
        </Empty>
      ) : (
        <div className="rows">
          {items.map((g) => (
            <Link key={g.id} to={`/studio/galleries/${g.id}`} className="row">
              <span className="grow">
                <b>{g.title}</b>
                <span>
                  {g.photoCount === 1 ? "1 photo" : `${g.photoCount} photos`}
                  {g.status === "archived" ? " · zip saved in the Archive folder" : g.expiresAt ? ` · expires ${new Date(g.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}
                </span>
              </span>
              <StatusChip tone={GALLERY_STATE[g.status].tone}>
                {GALLERY_STATE[g.status].label}
              </StatusChip>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}
