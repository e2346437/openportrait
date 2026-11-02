import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Avatar, Button, Callout, Icon, Panel, StatusChip, TextArea, useToast, type IconName } from "@openportrait/ui";
import { HouseholdPanel } from "../../components/HouseholdPanel.js";
import { CreditPanel } from "../../components/CreditPanel.js";
import { ContactDialog } from "../../components/ContactDialog.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDate, formatDateTime, ms, relative } from "../../lib/time.js";
import { SHOOT_STATUS, type ContactDetail, type TimelineItem } from "../../lib/types.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";

const KIND_ICON: Record<string, IconName> = { "lead.": "lead", "shoot.": "camera", "contact.": "user" };
const iconFor = (item: TimelineItem): IconName => (item.type === "note" ? "note" : (Object.entries(KIND_ICON).find(([p]) => item.kind.startsWith(p))?.[1] ?? "info"));

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const { data: c, error, reload, setData } = useLoad<ContactDetail>(`/contacts/${id}`);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [tagDraft, setTagDraft] = useState("");

  const addNote = useSubmit(() => api(`/contacts/${id}/notes`, { body: { body: note } }));
  const saveTags = async (tags: string[]) => {
    try {
      const res = await api<{ tags: string[] }>(`/contacts/${id}/tags`, { method: "PUT", body: { tags } });
      setData((d) => (d ? { ...d, tags: res.tags } : d));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save tags.", "bad");
    }
  };

  if (error) {
    return (
      <>
        <Link to="/studio/clients" className="back">
          <Icon name="arrowLeft" /> Clients
        </Link>
        <Callout tone="bad" title="Couldn't open this contact">{error}</Callout>
      </>
    );
  }
  if (!c) {
    return (
      <div aria-busy="true" className="stack">
        <div className="skeleton" style={{ height: 22, width: 90 }} />
        <div className="skeleton" style={{ height: 40, width: "45%" }} />
        <div className="skeleton" style={{ height: 220 }} />
      </div>
    );
  }

  const archived = c.archivedAt !== null;
  const address = [c.addressLine1, c.addressLine2, [c.city, c.region].filter(Boolean).join(", "), c.postalCode, c.country].filter(Boolean).join(" · ");

  const onNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    if (await addNote.submit()) {
      setNote("");
      await reload();
    }
  };
  const addTag = () => {
    const t = tagDraft.trim();
    setTagDraft("");
    if (t && !c.tags.some((x) => x.toLowerCase() === t.toLowerCase())) void saveTags([...c.tags, t]);
  };
  const toggleArchive = async () => {
    try {
      await api(`/contacts/${id}/${archived ? "restore" : "archive"}`, { method: "POST" });
      toast(archived ? "Contact restored" : "Contact archived");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't work.", "bad");
    }
  };

  return (
    <>
      <Link to="/studio/clients" className="back">
        <Icon name="arrowLeft" /> Clients
      </Link>

      <header className="page-head">
        <div style={{ display: "flex", gap: 16, alignItems: "center", minWidth: 0 }}>
          <Avatar name={c.name} size={56} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ overflowWrap: "anywhere" }}>{c.name}</h1>
            <div className="facts">
              {c.email ? (
                <a href={`mailto:${c.email}`}>
                  <Icon name="mail" /> {c.email}
                </a>
              ) : null}
              {c.phone ? (
                <a href={`tel:${c.phone}`}>
                  <Icon name="phone" /> {c.phone}
                </a>
              ) : null}
              {c.company && c.company !== c.name ? <span>{c.company}</span> : null}
              {address ? (
                <span>
                  <Icon name="pin" /> {address}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="actions">
          <Button icon="edit" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="ghost" onClick={toggleArchive}>
            {archived ? "Restore" : "Archive"}
          </Button>
        </div>
      </header>

      {archived ? <Callout tone="warn" title="This contact is archived">They're hidden from your client list and search. Their history is kept.</Callout> : null}

      <div className="split">
        <div className="stack">
          <Panel title="Notes and history" description="Private to your studio.">
            <form className="composer" onSubmit={onNote} noValidate>
              <TextArea aria-label="Add a note" placeholder="Add a note: preferences, what you talked about, things to remember…" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={10000} />
              {addNote.error ? <Callout tone="bad">{addNote.error}</Callout> : null}
              <div className="form-actions">
                <Button type="submit" variant="primary" size="sm" loading={addNote.busy} disabled={!note.trim()}>
                  Save note
                </Button>
              </div>
            </form>
            {c.timeline.length === 0 ? (
              <p className="hint">Nothing here yet.</p>
            ) : (
              <div className="timeline">
                {c.timeline.map((item) => (
                  <div key={`${item.type}-${item.id}`} className={`tl ${item.type}`}>
                    <span className="tl-dot">
                      <Icon name={iconFor(item)} />
                    </span>
                    <div className="tl-body">
                      {item.type === "note" ? <p>{item.text}</p> : <b style={{ fontWeight: 600 }}>{item.text}</b>}
                      <div className="tl-meta" title={formatDateTime(ms(item.at), tz)}>
                        {relative(ms(item.at))}
                        {item.by ? ` · ${item.by}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Tags">
            <div className="tags">
              {c.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => saveTags(c.tags.filter((x) => x !== t))}>
                    <Icon name="x" />
                  </button>
                </span>
              ))}
              <input
                className="tag-input"
                aria-label="Add a tag"
                placeholder="Add tag…"
                maxLength={40}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
              />
            </div>
          </Panel>

          <HouseholdPanel contact={c} onChanged={reload} />

          <CreditPanel contactId={c.id} />

          <Panel
            flush
            title="Shoots"
            actions={
              <Button size="sm" icon="plus" onClick={() => navigate(`/studio/shoots?new=${c.id}`)}>
                New shoot
              </Button>
            }
          >
            {c.shoots.length === 0 ? (
              <p className="hint" style={{ padding: "var(--s4) var(--s5)" }}>No shoots yet.</p>
            ) : (
              <div className="rows">
                {c.shoots.map((s) => (
                  <Link key={s.id} to={`/studio/shoots/${s.id}`} className="row">
                    <span className="grow">
                      <b>{s.subject}</b>
                      <span>
                        {s.shootType}
                        {s.startsAt ? ` · ${formatDate(ms(s.startsAt), tz, { month: "short", day: "numeric", year: "numeric" })}` : " · no date yet"}
                      </span>
                    </span>
                    <StatusChip tone={SHOOT_STATUS[s.status].tone}>{SHOOT_STATUS[s.status].label}</StatusChip>
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <Panel flush title="Inquiries">
            {c.leads.length === 0 ? (
              <p className="hint" style={{ padding: "var(--s4) var(--s5)" }}>No inquiries yet.</p>
            ) : (
              <div className="rows">
                {c.leads.map((l) => (
                  <Link key={l.id} to={`/studio/leads/${l.id}`} className="row">
                    <span className="grow">
                      <b>{l.shootType ?? "Inquiry"}</b>
                      <span>{formatDate(ms(l.createdAt), tz, { month: "short", day: "numeric", year: "numeric" })}</span>
                    </span>
                    <StatusChip tone={l.stageKind === "won" ? "ok" : l.stageKind === "lost" ? "neutral" : "info"}>{l.stage}</StatusChip>
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          {c.source ? (
            <p className="hint">
              Found you through <b>{c.source}</b>. Added {formatDate(ms(c.createdAt), tz, { month: "long", day: "numeric", year: "numeric" })}.
            </p>
          ) : null}
        </div>
      </div>

      <ContactDialog
        open={editing}
        contactId={id}
        initial={c}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          toast("Contact saved");
          await reload();
        }}
      />
    </>
  );
}
