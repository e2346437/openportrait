import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Avatar, Button, Callout, EmptyState, Icon, PageHeader, Panel, StatusChip, TextInput } from "@openportrait/ui";
import { ContactDialog } from "../../components/ContactDialog.js";
import type { ContactSummary } from "../../lib/types.js";
import { useDebounced, useLoad } from "../../lib/useLoad.js";

const PAGE = 50;

export function ClientsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [archived, setArchived] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const term = useDebounced(q.trim());
  const params = new URLSearchParams({ limit: String(limit) });
  if (term) params.set("q", term);
  if (tag) params.set("tag", tag);
  if (archived) params.set("archived", "true");
  const { data, error, loading } = useLoad<{ total: number; items: ContactSummary[] }>(`/contacts?${params}`);
  const { data: tagData } = useLoad<{ tags: Array<{ name: string; contacts: number }> }>("/tags");

  const filtered = Boolean(term || tag || archived);
  const items = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Clients"
        description="Everyone you've worked with or might. Open a person to see their inquiries, shoots and notes."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add contact
          </Button>
        }
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <TextInput type="search" aria-label="Search clients" placeholder="Search by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {tagData && tagData.tags.length > 0 ? (
          <select className="input" style={{ width: "auto" }} aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tagData.tags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.contacts})
              </option>
            ))}
          </select>
        ) : null}
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>
            Active
          </button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>
            Archived
          </button>
        </div>
      </div>

      {error ? <Callout tone="bad" title="Couldn't load your clients">{error}</Callout> : null}

      <Panel flush>
        {data === null && !error ? (
          <div className="rows" aria-busy="true" aria-label="Loading clients">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="row">
                <div className="skeleton" style={{ width: 36, height: 36, borderRadius: "50%" }} />
                <div className="grow">
                  <div className="skeleton" style={{ height: 14, width: "40%" }} />
                  <div className="skeleton" style={{ height: 12, width: "25%", marginTop: 6 }} />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState icon="search" title={archived && !term && !tag ? "No archived clients" : "No one matches"} action={<Button onClick={() => { setQ(""); setTag(""); setArchived(false); }}>Clear filters</Button>}>
              {archived && !term && !tag ? "Clients you archive show up here, with their history intact." : "Try a different spelling, or search by email or phone."}
            </EmptyState>
          ) : (
            <EmptyState icon="users" title="No clients yet" action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add your first contact</Button>}>
              Contacts also appear here automatically when someone sends an inquiry. Add one yourself to get started.
            </EmptyState>
          )
        ) : (
          <div className="rows">
            {items.map((c) => (
              <Link key={c.id} to={`/studio/clients/${c.id}`} className="row">
                <Avatar name={c.name} />
                <span className="grow">
                  <b>{c.name}</b>
                  <span>{[c.company && c.company !== c.name ? c.company : null, c.email, c.phone].filter(Boolean).join(" · ") || "No contact details yet"}</span>
                </span>
                {c.tags.length ? (
                  <span className="aside">
                    {c.tags.slice(0, 2).map((t) => (
                      <StatusChip key={t}>{t}</StatusChip>
                    ))}
                    {c.tags.length > 2 ? <span className="muted">+{c.tags.length - 2}</span> : null}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </Panel>

      {data && data.total > items.length ? (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Button loading={loading} onClick={() => setLimit(limit + PAGE)}>
            Show more ({data.total - items.length} left)
          </Button>
        </div>
      ) : data && data.total > 0 ? (
        <p className="hint" style={{ textAlign: "center" }}>
          {data.total} {data.total === 1 ? "client" : "clients"}
        </p>
      ) : null}

      <ContactDialog open={adding} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/studio/clients/${c.id}`)} />
    </>
  );
}
