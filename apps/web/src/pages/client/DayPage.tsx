import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Button, Field, Icon, Spinner, TextInput } from "@openportrait/ui";
import { Lightbox } from "../../galleries/Lightbox.js";
import { PhotoGrid } from "../../galleries/PhotoGrid.js";
import { plural, type GalleryDesign, type PhotoBase } from "../../lib/galleries.js";

interface Person {
  id: string;
  name: string;
  count: number;
  cover: { thumb: string; width: number | null; height: number | null; placeholder: string | null } | null;
}
interface Page {
  studio: { name: string; logo: string | null };
  title: string;
  locked: boolean;
  people: Person[];
}
interface Photo {
  id: string;
  width: number | null;
  height: number | null;
  placeholder: string | null;
  thumb: string;
  preview: string;
}

class DayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/day/${path}`, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new DayError(0, "You seem to be offline. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new DayError(res.status, data.message ?? "Something went wrong. Please try again.");
  return data as T;
}

const DESIGN: GalleryDesign = { layout: "full", landing: "photos", startSetId: null, nav: "both", filenames: false, grid: "justified", size: "m", spacing: 8, theme: "light", font: "serif" };

/** The organisation's page for a group day: one card per person, each opening that person's photos as previews. */
export function DayPage() {
  const { token = "" } = useParams();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<DayError | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Person | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await call<Page>(encodeURIComponent(token)));
      setError(null);
    } catch (e) {
      setError(e as DayError);
    }
  }, [token]);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => (page?.people ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())), [page, q]);

  if (error)
    return (
      <div className="client t-light cmsg">
        <div>
          <Icon name="image" />
          <h1>{error.status === 404 ? "Page not found" : "Couldn't open this page"}</h1>
          <p>{error.message}</p>
          {error.status !== 404 ? (
            <Button variant="primary" onClick={() => window.location.reload()}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  if (!page)
    return (
      <div className="client t-light boot" aria-busy="true" aria-label="Loading">
        <Spinner />
      </div>
    );
  if (page.locked) return <Password token={token} page={page} onThrough={load} />;

  if (open) return <PersonView token={token} person={open} studio={page.studio.name} onBack={() => setOpen(null)} />;

  return (
    <div className="client t-light dp">
      <header className="dp-head">
        <div className="dp-studio">{page.studio.logo ? <img src={page.studio.logo} alt={page.studio.name} /> : page.studio.name}</div>
        <h1>{page.title}</h1>
        <p>
          {plural(page.people.length, "person", "people")} photographed. These are previews; your photographer will let you know when downloads open.
        </p>
        {page.people.length > 8 ? (
          <label className="dp-search">
            <span className="sr-only">Search people</span>
            <Icon name="search" />
            <input type="search" placeholder={`Search ${page.people.length} people`} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        ) : null}
      </header>
      {page.people.length === 0 ? (
        <p className="dp-empty">Photos appear here as each person's gallery is finished. Check back soon.</p>
      ) : shown.length === 0 ? (
        <p className="dp-empty">No one matches “{q}”.</p>
      ) : (
        <ul className="dp-grid">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" className="dp-card" onClick={() => setOpen(p)}>
                <span className="dp-thumb" style={{ backgroundImage: p.cover?.placeholder ? `url(${p.cover.placeholder})` : undefined }}>
                  {p.cover ? <img src={p.cover.thumb} alt="" loading="lazy" decoding="async" /> : <Icon name="image" />}
                </span>
                <b>{p.name}</b>
                <small>{plural(p.count, "photo")}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonView({ token, person, studio, onBack }: { token: string; person: Person; studio: string; onBack: () => void }) {
  const [photos, setPhotos] = useState<Array<Photo & PhotoBase> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let stop = false;
    call<{ photos: Photo[] }>(`${encodeURIComponent(token)}/people/${encodeURIComponent(person.id)}`)
      .then((r) => !stop && setPhotos(r.photos.map((p, i) => ({ ...p, setId: "", filename: `Photo ${i + 1}`, takenAt: null }))))
      .catch((e: DayError) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [token, person.id]);
  return (
    <div className="client t-light dp">
      <header className="dp-head slim">
        <button type="button" className="btn" onClick={onBack}>
          <Icon name="arrowLeft" /> Everyone
        </button>
        <h1>{person.name}</h1>
        <p>{studio}</p>
      </header>
      {error ? <p className="dp-empty">{error}</p> : !photos ? <div className="dp-empty"><Spinner /></div> : photos.length === 0 ? <p className="dp-empty">No photos yet.</p> : <PhotoGrid photos={photos} design={DESIGN} onOpen={(p) => setAt(photos.findIndex((x) => x.id === p.id))} />}
      {photos && at !== null ? <Lightbox photos={photos} index={at} onIndex={setAt} onClose={() => setAt(null)} /> : null}
    </div>
  );
}

function Password({ token, page, onThrough }: { token: string; page: Page; onThrough: () => void | Promise<void> }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`${encodeURIComponent(token)}/unlock`, "POST", { password: pw });
      await onThrough();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="client t-light cmsg">
      <form onSubmit={go}>
        <Icon name="lock" />
        <h1>{page.title}</h1>
        <p>Enter the password your photographer gave you.</p>
        <Field label="Password" error={error ?? undefined}>
          {(p) => <TextInput {...p} type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!pw}>
          Open
        </Button>
      </form>
    </div>
  );
}
