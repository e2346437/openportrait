import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Callout, Dialog, EmptyState, Field, Icon, PageHeader, Panel, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { ContactPicker, type PickedContact } from "../../components/ContactPicker.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { formatDate, formatTime, ms, zonedToMs } from "../../lib/time.js";
import { SHOOT_STATUS, type ShootDetail, type ShootListItem, type ShootType } from "../../lib/types.js";
import { useSubmit } from "../../lib/useForm.js";
import { useDebounced, useLoad } from "../../lib/useLoad.js";

type When = "upcoming" | "past" | "all";
const PAGE = 50;

export function ShootsPage() {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [when, setWhen] = useState<When>("upcoming");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(search.has("new"));
  const term = useDebounced(q.trim());
  const params = new URLSearchParams({ when, limit: String(limit) });
  if (term) params.set("q", term);
  const { data, error, loading } = useLoad<{ total: number; items: ShootListItem[] }>(`/shoots?${params}`);
  const items = data?.items ?? [];

  const closeNew = () => {
    setAdding(false);
    if (search.has("new")) {
      const next = new URLSearchParams(search);
      next.delete("new");
      setSearch(next, { replace: true });
    }
  };

  return (
    <>
      <PageHeader
        title="Shoots"
        description="Every job from booking to delivery."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            New shoot
          </Button>
        }
      />
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <TextInput type="search" aria-label="Search shoots" placeholder="Search by subject, client or type" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg" role="group" aria-label="Show">
          {(["upcoming", "past", "all"] as const).map((w) => (
            <button key={w} type="button" aria-pressed={when === w} onClick={() => { setWhen(w); setLimit(PAGE); }}>
              {w === "upcoming" ? "Upcoming" : w === "past" ? "Past" : "All"}
            </button>
          ))}
        </div>
      </div>
      {error ? <Callout tone="bad" title="Couldn't load your shoots">{error}</Callout> : null}
      <Panel flush>
        {data === null && !error ? (
          <div className="rows" aria-busy="true" aria-label="Loading shoots">
            {[0, 1, 2].map((i) => (
              <div key={i} className="row">
                <div className="skeleton" style={{ width: 56, height: 44 }} />
                <div className="grow">
                  <div className="skeleton" style={{ height: 14, width: "45%" }} />
                  <div className="skeleton" style={{ height: 12, width: "30%", marginTop: 6 }} />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          term ? (
            <EmptyState icon="search" title="No shoots match" action={<Button onClick={() => setQ("")}>Clear search</Button>}>
              Try a client's name, or a type like “Wedding”.
            </EmptyState>
          ) : (
            <EmptyState
              icon="camera"
              title={when === "upcoming" ? "Nothing coming up" : when === "past" ? "No past shoots" : "No shoots yet"}
              action={
                <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                  New shoot
                </Button>
              }
            >
              {when === "upcoming" ? "Book a lead, or add a shoot yourself. Each one gets its own folder on your gallery share." : "Shoots you've finished show up here."}
            </EmptyState>
          )
        ) : (
          <div className="rows">
            {items.map((s) => (
              <Link key={s.id} to={`/studio/shoots/${s.id}`} className="row">
                <DateBlock at={s.startsAt} tz={tz} />
                <span className="grow">
                  <b>{s.subject}</b>
                  <span>
                    {s.shootType}
                    {s.startsAt ? ` · ${formatTime(ms(s.startsAt), tz)}` : ""}
                    {s.location ? ` · ${s.location}` : ""}
                    {s.client !== s.subject ? ` · ${s.client}` : ""}
                  </span>
                </span>
                <StatusChip tone={SHOOT_STATUS[s.status].tone}>{SHOOT_STATUS[s.status].label}</StatusChip>
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
      ) : null}

      <NewShootDialog
        open={adding}
        presetContactId={search.get("new") && search.get("new") !== "1" ? search.get("new")! : undefined}
        tz={tz}
        onClose={closeNew}
        onCreated={(shoot) => navigate(`/studio/shoots/${shoot.id}`)}
      />
    </>
  );
}

export function DateBlock({ at, tz }: { at: string | number | null; tz: string }) {
  if (at === null) {
    return (
      <span className="dateblock none" aria-label="No date yet">
        <b>—</b>
        <small>no date</small>
      </span>
    );
  }
  const t = ms(at);
  return (
    <span className="dateblock">
      <b>{formatDate(t, tz, { day: "numeric" })}</b>
      <small>{formatDate(t, tz, { month: "short" })}</small>
    </span>
  );
}

export function NewShootDialog({ open, presetContactId, tz, onClose, onCreated }: { open: boolean; presetContactId?: string; tz: string; onClose: () => void; onCreated: (s: ShootDetail, folderError: string | null) => void }) {
  const toast = useToast();
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [typeId, setTypeId] = useState("");
  const [subject, setSubject] = useState("");
  const [start, setStart] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [location, setLocation] = useState("");
  const { data: types } = useLoad<{ types: ShootType[] }>(open ? "/shoot-types" : null);
  const { data: preset } = useLoad<{ id: string; name: string }>(open && presetContactId ? `/contacts/${presetContactId}` : null);

  useEffect(() => {
    if (open && preset && !contact) setContact({ id: preset.id, name: preset.name });
  }, [open, preset, contact]);

  const { busy, error, fieldErrors, submit } = useSubmit(() => {
    const startsAt = start ? zonedToMs(start, tz) : NaN;
    const events = Number.isFinite(startsAt) ? [{ startsAt, endsAt: startsAt + Number(minutes || 60) * 60_000, location: location || undefined }] : [];
    return api<{ shoot: ShootDetail; folderError: string | null }>("/shoots", { body: { primaryContactId: contact?.id, shootTypeId: typeId, subject: subject || undefined, events } });
  });

  const go = async (e: FormEvent) => {
    e.preventDefault();
    const res = await submit();
    if (!res) return;
    if (res.folderError) toast("Shoot created, but its folder couldn't be made yet.", "bad");
    else toast("Shoot created");
    setContact(null);
    setTypeId("");
    setSubject("");
    setStart("");
    setLocation("");
    onCreated(res.shoot, res.folderError);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New shoot"
      description="A date creates its folder on your gallery share straight away."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="shoot-form" loading={busy} disabled={!contact || !typeId}>
            Create shoot
          </Button>
        </>
      }
    >
      <form id="shoot-form" onSubmit={go} noValidate className="form-grid">
        {error ? (
          <div className="span-2">
            <Callout tone="bad">{error}</Callout>
          </div>
        ) : null}
        <div className="span-2">
          <ContactPicker value={contact} onChange={setContact} label="Client" />
        </div>
        <Field label="Type of shoot" error={fieldErrors.shootTypeId}>
          {(p) => (
            <select {...p} className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Choose…</option>
              {types?.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Who's being photographed" hint={contact ? `Leave blank to use ${contact.name}.` : "Used in the folder name."}>
          {(p) => <TextInput {...p} autoComplete="off" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder={contact?.name} />}
        </Field>
        <Field label="Starts" hint="In your studio's time zone. Optional for now.">
          {(p) => <TextInput {...p} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}
        </Field>
        <Field label="Length (minutes)">
          {(p) => <TextInput {...p} type="number" min={5} step={5} inputMode="numeric" value={minutes} disabled={!start} onChange={(e) => setMinutes(e.target.value)} />}
        </Field>
        <Field className="span-2" label="Location" hint="Optional.">
          {(p) => <TextInput {...p} autoComplete="off" value={location} maxLength={200} disabled={!start} onChange={(e) => setLocation(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
