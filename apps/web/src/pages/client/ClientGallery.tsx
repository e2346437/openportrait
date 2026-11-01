import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router";
import { Button, Dialog, Field, Icon, Mark, Spinner, TextArea, TextInput } from "@openportrait/ui";
import { focalPos, formatDate, plural, type ClientGallery, type ClientMe, type PhotoBase } from "../../lib/galleries.js";
import { Lightbox } from "../../galleries/Lightbox.js";
import { PhotoGrid } from "../../galleries/PhotoGrid.js";

class ClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/g/${path}`, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ClientError(0, "You seem to be offline. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) throw new ClientError(res.status, data.message ?? "Something went wrong. Please try again.", data.error);
  return data as T;
}

type Pending = { kind: "favorite"; photoId: string } | { kind: "download"; photoId: string } | { kind: "drawer" } | { kind: "zips" } | null;

/** The public client gallery at /g/:slug (docs/GALLERIES.md section 6). */
export function ClientGalleryPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ClientGallery | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [me, setMe] = useState<ClientMe>({ email: null, selections: [] });
  const [open, setOpen] = useState<number | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [gate, setGate] = useState<Pending>(null);
  const [activeList, setActiveList] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zips, setZips] = useState(false);

  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let alive = true;
    call<ClientGallery>(encodeURIComponent(slug))
      .then((d) => {
        if (!alive) return;
        setData(d);
        setMe(d.me);
        setActiveList(d.lists[0]?.id ?? null);
      })
      .catch((e: ClientError) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [slug, reloads]);

  useEffect(() => {
    if (!data) return;
    document.title = `${data.gallery.title}${data.studio.name ? ` · ${data.studio.name}` : ""}`;
    const meta = document.querySelector('meta[name="theme-color"]:not([media])') ?? Object.assign(document.head.appendChild(document.createElement("meta")), { name: "theme-color" });
    meta.setAttribute("content", data.gallery.design.theme === "dark" ? "#100f0e" : "#fbfaf7");
  }, [data]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(t);
  }, [notice]);

  const setId = params.get("set");
  const design = data?.gallery.design;
  const sets = data?.sets ?? [];
  const showCards = design?.landing === "cards" && sets.length > 1;
  const allPhotos = setId === "all";
  // A gallery can open straight on one chosen set; "All" then asks for everything explicitly.
  const startId = design?.landing === "set" ? design.startSetId : null;
  const currentSet = sets.find((s) => s.id === (setId ?? startId)) ?? null;
  const homeParam = design?.landing === "set" ? "all" : null;
  const visible = useMemo(() => (data ? (currentSet ? data.photos.filter((p) => p.setId === currentSet.id) : data.photos) : []), [data, currentSet]);
  const list = data?.lists.find((l) => l.id === activeList) ?? data?.lists[0] ?? null;
  const selection = me.selections.find((s) => s.listId === list?.id);
  const picked = useMemo(() => new Set(selection?.photoIds ?? []), [selection]);
  const totalPicked = me.selections.reduce((n, s) => n + s.photoIds.length, 0);
  const setOf = useCallback((p: PhotoBase) => sets.find((s) => s.id === p.setId), [sets]);
  const canDownload = (p: PhotoBase) => setOf(p)?.download.allowed ?? false;
  const anyLocked = sets.some((s) => !s.download.allowed && s.download.reason === "locked");

  const goSet = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("set", id);
    else next.delete("set");
    setParams(next);
    document.getElementById("photos")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const doDownload = (photoId: string) => {
    const a = document.createElement("a");
    a.href = `/api/g/${encodeURIComponent(slug)}/photos/${photoId}/download`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const toggleFavorite = async (photoId: string) => {
    if (!list) return;
    if (!me.email) return setGate({ kind: "favorite", photoId });
    if (selection?.submittedAt) {
      setNotice(`You already sent “${list.name}”. Ask the studio to reopen it if you'd like to change it.`);
      return;
    }
    const on = picked.has(photoId);
    // Show the change right away; the server answer replaces it.
    setMe((m) => ({
      ...m,
      selections: m.selections.some((s) => s.listId === list.id)
        ? m.selections.map((s) => (s.listId === list.id ? { ...s, photoIds: on ? s.photoIds.filter((x) => x !== photoId) : [...s.photoIds, photoId] } : s))
        : [...m.selections, { listId: list.id, submittedAt: null, photoIds: [photoId], notes: {} }],
    }));
    try {
      const r = await call<{ me: ClientMe }>(`${encodeURIComponent(slug)}/lists/${list.id}/photos/${photoId}`, on ? "DELETE" : "PUT", {});
      setMe(r.me);
    } catch (e) {
      const err = e as ClientError;
      if (err.code === "identify") {
        setMe({ email: null, selections: [] });
        setGate({ kind: "favorite", photoId });
      } else setNotice(err.message);
      call<ClientGallery>(encodeURIComponent(slug)).then((d) => setMe(d.me), () => {});
    }
  };

  const onIdentified = async (next: ClientMe) => {
    setMe(next);
    const pending = gate;
    setGate(null);
    if (pending?.kind === "download") doDownload(pending.photoId);
    if (pending?.kind === "drawer") setDrawer(true);
    if (pending?.kind === "zips") setZips(true);
    if (pending?.kind === "favorite" && list) {
      const already = next.selections.find((s) => s.listId === list.id)?.photoIds.includes(pending.photoId);
      if (!already) {
        try {
          const r = await call<{ me: ClientMe }>(`${encodeURIComponent(slug)}/lists/${list.id}/photos/${pending.photoId}`, "PUT", {});
          setMe(r.me);
        } catch (e) {
          setNotice((e as Error).message);
        }
      }
    }
  };

  if (error) return <ClientMessage error={error} />;
  if (data?.gate) return <GateScreen slug={slug} data={data} onThrough={() => setReloads((n) => n + 1)} />;
  if (!data || !design) {
    return (
      <div className="client t-light boot" aria-busy="true" aria-label="Loading gallery">
        <Spinner />
      </div>
    );
  }

  const g = data.gallery;
  const cover = g.cover;
  const coverStyle = cover ? { backgroundImage: `url(${cover.preview}), url(${cover.placeholder ?? ""})`, backgroundPosition: focalPos(g.coverFocalX, g.coverFocalY) } : undefined;
  const dateText = formatDate(g.date, { month: "long", day: "numeric", year: "numeric" });
  const studioName = data.studio.name;

  const shareGallery = async () => {
    const url = window.location.origin + window.location.pathname;
    try {
      if (navigator.share) await navigator.share({ title: g.title, url });
      else {
        await navigator.clipboard.writeText(url);
        setNotice("Link copied. Paste it anywhere to share.");
      }
    } catch {
      /* the share sheet was dismissed */
    }
  };

  const heart = (p: PhotoBase, cls: string, withLabel = false) => {
    const on = picked.has(p.id);
    return (
      <button type="button" className={`${cls}${on ? " on" : ""}`} aria-pressed={on} aria-label={on ? `Remove from ${list?.name ?? "favorites"}` : `Add to ${list?.name ?? "favorites"}`} title={data.lists.length > 1 ? list?.name : undefined} onClick={() => toggleFavorite(p.id)}>
        <Icon name="heart" fill={on ? "currentColor" : "none"} />
        {withLabel ? <span className="lbl">{on ? "Favorited" : "Favorite"}</span> : null}
      </button>
    );
  };
  const download = (p: PhotoBase, cls: string, withLabel = false) =>
    canDownload(p) ? (
      <button type="button" className={`${cls} dl`} aria-label={`Download ${p.filename}`} onClick={() => (me.email ? doDownload(p.id) : setGate({ kind: "download", photoId: p.id }))}>
        <Icon name="download" />
        {withLabel ? <span className="lbl">Download</span> : null}
      </button>
    ) : null;

  return (
    <div className={`client t-${design.theme} f-${design.font} nav-${design.nav}`}>
      {g.preview ? (
        <div className="preview-bar" role="status">
          <Icon name="eye" /> Preview. Clients can't see this gallery until you share it.
        </div>
      ) : null}

      <header className={`cover l-${design.layout}`} style={design.layout === "full" ? coverStyle : undefined}>
        {data.studio.logo ? <img className="studio-logo" src={data.studio.logo} alt={studioName || "Studio logo"} /> : studioName ? <div className="studio-mark">{studioName}</div> : null}
        {design.layout === "split" && cover ? <div className="split-img" style={coverStyle} role="img" aria-label="Cover photo" /> : null}
        {design.layout === "framed" && cover ? <div className="frame-img" style={coverStyle} role="img" aria-label="Cover photo" /> : null}
        <div className="cover-in">
          <div>
            <h1>{g.title}</h1>
            <p>
              {dateText}
              {dateText ? " · " : ""}
              {plural(data.photos.length, "photo")}
            </p>
            {g.welcomeMessage ? <p className="welcome">{g.welcomeMessage}</p> : null}
          </div>
          <a className="cover-down" href="#photos" aria-label="View the photos">
            <Icon name="chevronDown" />
          </a>
        </div>
      </header>

      <nav className="gbar" aria-label="Gallery">
        <div className="gbar-in">
          <div className="gname">
            {data.studio.logo ? (
              <img className="gname-logo" src={data.studio.logo} alt={studioName || g.title} />
            ) : (
              <>
                <b>{g.title}</b>
                {studioName ? <span>{studioName}</span> : null}
              </>
            )}
          </div>
          {sets.length > 1 ? (
            <div className="gsets">
              <button type="button" aria-pressed={!currentSet && !allPhotos} aria-label={showCards ? "Home" : "All photos"} onClick={() => goSet(homeParam)}>
                <Icon name={showCards ? "grid" : "image"} />
                <span className="nl">{showCards ? "Home" : "All"}</span>
              </button>
              {showCards ? (
                <button type="button" aria-pressed={allPhotos} onClick={() => goSet("all")}>
                  <Icon name="image" />
                  <span className="nl">All photos</span>
                </button>
              ) : null}
              {sets.map((s) => (
                <button key={s.id} type="button" className="setlink" aria-pressed={currentSet?.id === s.id} onClick={() => goSet(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="gsets" />
          )}
          <div className="gacts">
            {data.lists.length ? (
              <button type="button" className="gbtn" onClick={() => (me.email ? setDrawer(true) : setGate({ kind: "drawer" }))}>
                <Icon name="heart" />
                <span className="lbl">Favorites</span>
                {totalPicked ? <span className="cnt">{totalPicked}</span> : null}
              </button>
            ) : null}
            {sets.some((s) => s.download.allowed) || anyLocked ? (
              <button type="button" className="gbtn" aria-label="Download photos" onClick={() => (me.email ? setZips(true) : setGate({ kind: "zips" }))}>
                <Icon name="download" />
                <span className="lbl">Download</span>
              </button>
            ) : null}
            <button type="button" className="gbtn" aria-label="Share gallery" onClick={shareGallery}>
              <Icon name="send" />
              <span className="lbl">Share</span>
            </button>
          </div>
        </div>
      </nav>

      <main id="photos" className="gmain">
        {anyLocked ? (
          <p className="lockbar">
            <Icon name="lock" />
            {g.downloadLock === "highlights_early" ? "Some sets can be downloaded now. The rest open once your gallery is paid for." : "Downloads open once your gallery is paid for. You can still view and pick favorites."}
          </p>
        ) : null}

        {showCards && !currentSet && !allPhotos ? (
          <section className="landing" aria-labelledby="choose-set">
            <h2 id="choose-set">Choose a folder</h2>
            <p>Open a folder to enter the gallery, or view all photos.</p>
            <div className="setcards">
            {sets.map((s) => (
              <button key={s.id} type="button" className="setcard" onClick={() => goSet(s.id)}>
                <div className="sc-img" style={s.cover ? { backgroundImage: `url(${s.cover.preview}), url(${s.cover.placeholder ?? ""})`, backgroundPosition: focalPos(s.coverFocalX, s.coverFocalY) } : undefined} />
                <b>{s.name}</b>
                <span>{plural(s.count, "photo")}</span>
              </button>
            ))}
            </div>
            <button type="button" className="all-photos" onClick={() => goSet("all")}>
              View all photos
            </button>
          </section>
        ) : (
          <>
            {currentSet && showCards ? (
              <div className="banner" style={currentSet.cover ? { backgroundImage: `url(${currentSet.cover.preview})`, backgroundPosition: focalPos(currentSet.coverFocalX, currentSet.coverFocalY) } : undefined}>
                <div className="banner-in">
                  <h2>{currentSet.name}</h2>
                  <button type="button" onClick={() => goSet(null)}>
                    <Icon name="arrowLeft" /> All sets
                  </button>
                </div>
              </div>
            ) : null}
            {data.photos.length === 0 ? (
              <div className="placeholder">
                <Icon name="image" />
                <h2>Your photos are on the way</h2>
                <p>{g.welcomeMessage || "We're still preparing this gallery. Check back soon, and we'll let you know when it's ready."}</p>
              </div>
            ) : visible.length ? (
              <PhotoGrid
                photos={visible}
                design={design}
                onOpen={(p) => setOpen(visible.indexOf(p))}
                actions={(p) => (
                  <>
                    {data.lists.length ? heart(p, "tb") : null}
                    {download(p, "tb")}
                  </>
                )}
              />
            ) : (
              <p className="gempty">There are no photos here yet.</p>
            )}
          </>
        )}
      </main>

      {data.photos.length ? (
      <section className="next" aria-labelledby="next-h">
        <h2 id="next-h">What to do next?</h2>
        <div className="next-grid">
          {data.lists.length ? (
            <button type="button" onClick={() => (me.email ? setDrawer(true) : setGate({ kind: "drawer" }))}>
              <Icon name="heart" />
              <b>Choose your favorites</b>
              <span>Pick your favorite images in this gallery and send them to us.</span>
            </button>
          ) : null}
          <button type="button" onClick={shareGallery}>
            <Icon name="send" />
            <b>Share gallery</b>
            <span>Show off this gallery and share the link with family and friends.</span>
          </button>
          {data.studio.email ? (
            <a href={`mailto:${data.studio.email}?subject=${encodeURIComponent(g.title)}`}>
              <Icon name="help" />
              <b>Have questions?</b>
              <span>Send {studioName || "us"} a note and we'll get right back to you.</span>
            </a>
          ) : null}
        </div>
        <a className="to-top" href="#top" aria-label="Back to the top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
          <Icon name="chevronUp" />
        </a>
      </section>
      ) : null}

      <footer className="cfoot">
        <span>
          © {new Date().getFullYear()} {studioName || g.title}
        </span>
        <a href="https://openportrait.app" target="_blank" rel="noreferrer">
          <Mark size={14} title="" /> Made with OpenPortrait
        </a>
      </footer>

      {open !== null && visible[open] ? (
        <Lightbox
          photos={visible}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          paused={gate !== null}
          actions={(p) => (
            <>
              {data.lists.length ? heart(p, "lbb", true) : null}
              {download(p, "lbb", true)}
            </>
          )}
        />
      ) : null}

      {zips ? <ZipDialog slug={slug} locked={anyLocked} lockMode={g.downloadLock} onClose={() => setZips(false)} /> : null}
      <EmailGate slug={slug} pending={gate} onClose={() => setGate(null)} onDone={onIdentified} studioName={studioName} />
      {drawer && data.lists.length ? (
        <FavoritesDrawer slug={slug} data={data} me={me} setMe={setMe} activeList={list!.id} setActiveList={setActiveList} onClose={() => setDrawer(false)} onOpenPhoto={(id) => {
          const i = visible.findIndex((p) => p.id === id);
          if (i >= 0) {
            setDrawer(false);
            setOpen(i);
          }
        }} />
      ) : null}

      {notice ? (
        <div className="toasts" role="status" aria-live="polite">
          <div className="toast">{notice}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Shown before any photo: a password, registration (email, or email and name), or both. */
function GateScreen({ slug, data, onThrough }: { slug: string; data: ClientGallery; onThrough: () => void }) {
  const gate = data.gate!;
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const cover = data.gallery.cover;
  const needName = gate.register === "email_name";
  const studio = data.studio.name;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      if (gate.password) await call(`${encodeURIComponent(slug)}/unlock`, "POST", { password });
    } catch (e2) {
      setErrors({ password: (e2 as Error).message });
      setBusy(false);
      return;
    }
    try {
      if (gate.register) await call(`${encodeURIComponent(slug)}/identify`, "POST", { email, ...(needName ? { name } : {}) });
    } catch (e2) {
      const err = e2 as ClientError;
      setErrors({ [err.message.toLowerCase().includes("name") ? "name" : "email"]: err.message });
      setBusy(false);
      return;
    }
    onThrough();
  };
  return (
    <div className={`client t-${data.gallery.design.theme} f-${data.gallery.design.font} gatepage`}>
      {cover ? <div className="gate-bg" style={{ backgroundImage: `url(${cover.preview}), url(${cover.placeholder ?? ""})`, backgroundPosition: focalPos(data.gallery.coverFocalX, data.gallery.coverFocalY) }} aria-hidden="true" /> : null}
      <form className="gatecard" onSubmit={submit} noValidate>
        {data.studio.logo ? <img className="gate-logo" src={data.studio.logo} alt={studio} /> : studio ? <div className="studio-mark static">{studio}</div> : null}
        <h1>{data.gallery.title}</h1>
        <p>{gate.password ? "This gallery is private. Enter the password you were given to view it." : "Enter your details to view this gallery."}</p>
        {gate.password ? (
          <Field label="Password" error={errors.password}>
            {(p) => <TextInput {...p} type="password" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
          </Field>
        ) : null}
        {gate.register ? (
          <>
            {needName ? (
              <Field label="Your name" error={errors.name}>
                {(p) => <TextInput {...p} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus={!gate.password} />}
              </Field>
            ) : null}
            <Field label="Email" error={errors.email}>
              {(p) => <TextInput {...p} type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!gate.password && !needName} />}
            </Field>
          </>
        ) : null}
        <Button type="submit" variant="primary" block loading={busy} disabled={(gate.password && !password) || (!!gate.register && (!email.includes("@") || (needName && !name.trim())))}>
          View gallery
        </Button>
      </form>
    </div>
  );
}

interface ZipOption {
  key: string;
  name: string;
  scope: "gallery" | "set" | "favorites";
  setId?: string;
  listId?: string;
  count: number;
  bytes: number;
  parts: number;
}

const sizeText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Whole-gallery, per-set and favorites downloads as zip files, split into parts when they are very large. */
function ZipDialog({ slug, locked, lockMode, onClose }: { slug: string; locked: boolean; lockMode?: string; onClose: () => void }) {
  const [options, setOptions] = useState<ZipOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ downloads: ZipOption[] }>(`${encodeURIComponent(slug)}/downloads`)
      .then((r) => setOptions(r.downloads))
      .catch((e: Error) => setError(e.message));
  }, [slug]);
  const href = (o: ZipOption, part: number) => `/api/g/${encodeURIComponent(slug)}/zip?scope=${o.scope}${o.setId ? `&set=${o.setId}` : ""}${o.listId ? `&list=${o.listId}` : ""}&part=${part}`;
  return (
    <Dialog open onClose={onClose} title="Download photos" description="Each download is a zip file. Large galleries come in several parts so every part opens on any device.">
      {error ? <p className="dr-err">{error}</p> : null}
      {!options && !error ? <Spinner /> : null}
      {options && options.length === 0 ? (
        <p className="lockbar">
          <Icon name="lock" />
          {locked ? (lockMode === "highlights_early" ? "Downloads open once your gallery is paid for." : "Downloads open once your gallery is paid for. You can still view and pick favorites.") : "There's nothing to download yet."}
        </p>
      ) : null}
      <ul className="zips">
        {options?.map((o) => (
          <li key={o.key}>
            <div>
              <b>{o.name}</b>
              <span>
                {plural(o.count, "photo")} · {sizeText(o.bytes)}
              </span>
            </div>
            {o.parts === 1 ? (
              <a className="btn primary sm" href={href(o, 1)} download>
                <Icon name="download" /> Download
              </a>
            ) : (
              <div className="zparts">
                {Array.from({ length: o.parts }, (_, i) => (
                  <a key={i} className="btn sm" href={href(o, i + 1)} download>
                    Part {i + 1}
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {options?.some((o) => o.parts > 1) ? <p className="hint">Open all the parts and extract them into the same folder.</p> : null}
      {locked && options && options.length > 0 ? (
        <p className="lockbar">
          <Icon name="lock" />
          Some photos are still locked until your gallery is paid for.
        </p>
      ) : null}
    </Dialog>
  );
}

function EmailGate({ slug, pending, onClose, onDone, studioName }: { slug: string; pending: Pending; onClose: () => void; onDone: (me: ClientMe) => void; studioName: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ me: ClientMe }>(`${encodeURIComponent(slug)}/identify`, "POST", { email });
      onDone(r.me);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const what = pending?.kind === "download" || pending?.kind === "zips" ? "download" : "save your favorites";
  return (
    <Dialog
      open={pending !== null}
      onClose={onClose}
      title={pending?.kind === "download" || pending?.kind === "zips" ? "Where should we send your downloads?" : "Save your favorites"}
      description={`Enter your email to ${what}. ${studioName || "The studio"} uses it to see your picks, and it keeps them on any device.`}
    >
      <form onSubmit={submit} className="gate-form" noValidate>
        <Field label="Email" error={err}>
          {(p) => <TextInput {...p} type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
        </Field>
        <Button type="submit" variant="primary" block loading={busy} disabled={!email.includes("@")}>
          Continue
        </Button>
      </form>
    </Dialog>
  );
}

function FavoritesDrawer({ slug, data, me, setMe, activeList, setActiveList, onClose, onOpenPhoto }: { slug: string; data: ClientGallery; me: ClientMe; setMe: (m: ClientMe) => void; activeList: string; setActiveList: (id: string) => void; onClose: () => void; onOpenPhoto: (id: string) => void }) {
  const list = data.lists.find((l) => l.id === activeList)!;
  const sel = me.selections.find((s) => s.listId === list.id);
  const ids = sel?.photoIds ?? [];
  const photos = ids.map((id) => data.photos.find((p) => p.id === id)).filter((p): p is PhotoBase => !!p);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const locked = !!sel?.submittedAt;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !confirm && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirm]);

  const act = async (fn: () => Promise<{ me: ClientMe }>) => {
    setErr(null);
    try {
      setMe((await fn()).me);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const saveNote = (photoId: string, note: string) => {
    if ((sel?.notes[photoId] ?? "") === note.trim()) return;
    void act(() => call(`${encodeURIComponent(slug)}/lists/${list.id}/photos/${photoId}`, "PUT", { note }));
  };

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Your favorites">
        <div className="dr-head">
          <h2>Favorites</h2>
          <Button variant="ghost" className="icon" icon="x" aria-label="Close favorites" onClick={onClose} />
        </div>
        {data.lists.length > 1 ? (
          <div className="dr-lists" role="tablist" aria-label="Favorites lists">
            {data.lists.map((l) => {
              const n = me.selections.find((s) => s.listId === l.id)?.photoIds.length ?? 0;
              return (
                <button key={l.id} type="button" role="tab" aria-selected={l.id === list.id} onClick={() => setActiveList(l.id)}>
                  {l.name} <span>{l.maxCount ? `${n}/${l.maxCount}` : n}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="dr-body">
          <div className="counter">
            <span>{me.email}</span>
            <b>{list.maxCount ? `${photos.length} of ${list.maxCount}` : plural(photos.length, "photo")}</b>
          </div>
          {locked ? (
            <p className="locked-note">
              <Icon name="check" /> Sent to the studio on {formatDate(sel!.submittedAt)}. Ask them to reopen it if you want to make changes.
            </p>
          ) : null}
          {err ? <p className="dr-err">{err}</p> : null}
          {photos.length ? (
            <ul className="fitems">
              {photos.map((p) => (
                <li key={p.id} className="fitem">
                  <button type="button" className="ft" style={{ backgroundImage: `url(${p.thumb}), url(${p.placeholder ?? ""})` }} onClick={() => onOpenPhoto(p.id)} aria-label={`View ${p.filename}`} />
                  <div>
                    <div className="fn">{p.filename}</div>
                    {locked ? (
                      sel?.notes[p.id] ? <p className="fnote">{sel.notes[p.id]}</p> : null
                    ) : (
                      <TextArea aria-label={`Note for ${p.filename}`} rows={1} placeholder="Add a note (crop, edit, print size…)" defaultValue={sel?.notes[p.id] ?? ""} maxLength={500} onBlur={(e) => saveNote(p.id, e.target.value)} />
                    )}
                  </div>
                  {!locked ? (
                    <Button variant="ghost" size="sm" className="icon" icon="x" aria-label={`Remove ${p.filename}`} onClick={() => act(() => call(`${encodeURIComponent(slug)}/lists/${list.id}/photos/${p.id}`, "DELETE"))} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="dr-empty">
              <Icon name="heart" />
              <b>No favorites yet</b>
              <p>Tap the heart on any photo to add it to “{list.name}”.</p>
            </div>
          )}
        </div>
        {!locked && photos.length ? (
          <div className="dr-foot">
            <Button variant="primary" block icon="send" onClick={() => setConfirm(true)}>
              Send “{list.name}” to the studio
            </Button>
            <span className="hint">You can keep adding until you send it.</span>
          </div>
        ) : null}
      </aside>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Send ${plural(photos.length, "favorite")}?`}
        description="The studio is told right away. After sending, this list is locked unless they reopen it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep editing
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await act(() => call(`${encodeURIComponent(slug)}/lists/${list.id}/submit`, "POST"));
                setBusy(false);
                setConfirm(false);
              }}
            >
              Send
            </Button>
          </>
        }
      />
    </>
  );
}

function ClientMessage({ error }: { error: ClientError }) {
  return (
    <div className="client t-light cmsg">
      <div>
        <Icon name={error.status === 410 ? "lock" : "image"} />
        <h1>{error.status === 410 ? "This gallery has expired" : error.status === 404 ? "Gallery not found" : "Couldn't open the gallery"}</h1>
        <p>{error.message}</p>
        {error.status !== 404 && error.status !== 410 ? (
          <Button variant="primary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
