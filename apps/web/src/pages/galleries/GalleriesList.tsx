import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Callout, EmptyState, Icon, PageHeader, Panel, StatusChip, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { focalPos, plural, timeAgo, type GallerySummary, type InboxFolder } from "../../lib/galleries.js";

export function GalleriesListPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [galleries, setGalleries] = useState<GallerySummary[] | null>(null);
  const [folders, setFolders] = useState<InboxFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, f] = await Promise.all([api<{ galleries: GallerySummary[] }>("/galleries"), api<{ folders: InboxFolder[] }>("/ingest/folders")]);
      setGalleries(g.galleries);
      setFolders(f.folders);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While previews are being made, check back so thumbnails appear without a refresh.
  const busy = galleries?.some((g) => g.processing > 0);
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [busy, load]);

  const rescan = async () => {
    setScanning(true);
    try {
      await api("/ingest/rescan", { method: "POST", body: {} });
      await load();
      toast("Checked the gallery folder");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setScanning(false);
    }
  };

  const createFrom = async (f: InboxFolder) => {
    setCreating(f.id);
    try {
      const r = await api<{ galleryId: string }>(`/ingest/folders/${f.id}/gallery`, { method: "POST", body: {} });
      navigate(`/studio/galleries/${r.galleryId}`);
    } catch (e) {
      toast((e as Error).message, "bad");
      setCreating(null);
    }
  };

  const ignore = async (f: InboxFolder) => {
    try {
      await api(`/ingest/folders/${f.id}/ignore`, { method: "POST", body: {} });
      setFolders((x) => x.filter((y) => y.id !== f.id));
      toast(`Ignoring “${f.relPath}”`);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  return (
    <>
      <PageHeader
        title="Galleries"
        description="Photos on your gallery share become client galleries. Export from Lightroom or Aftershoot into a shoot's Gallery folder and they show up here."
        actions={
          <Button icon="refresh" loading={scanning} onClick={rescan}>
            Check for new photos
          </Button>
        }
      />

      {error ? (
        <Callout tone="bad" title="Couldn't load galleries" action={<Button size="sm" onClick={load}>Try again</Button>}>
          {error}
        </Callout>
      ) : null}

      {folders.length ? (
        <Panel
          title={`${plural(folders.length, "new folder")} to review`}
          description="These folders have photos but aren't a gallery yet. Create a gallery to import them, or ignore a folder you don't want to share."
        >
          <ul className="inbox-list">
            {folders.map((f) => (
              <li key={f.id} className="inbox-row">
                <div className="inbox-main">
                  <b>{f.suggestedTitle}</b>
                  <span className="path mono">{f.relPath}</span>
                  <span className="muted">
                    {plural(f.fileCount, "photo")} · {f.stable ? `last changed ${timeAgo(f.lastChangeAt)}` : "still being copied"}
                  </span>
                </div>
                <div className="inbox-acts">
                  {!f.stable ? <StatusChip tone="info" pulse>Copying</StatusChip> : null}
                  <Button size="sm" variant="ghost" onClick={() => ignore(f)}>
                    Ignore
                  </Button>
                  <Button size="sm" variant="primary" loading={creating === f.id} disabled={!f.stable} onClick={() => createFrom(f)}>
                    Create gallery
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {galleries === null && !error ? (
        <Panel>
          <div className="gl-skel" aria-busy="true" aria-label="Loading galleries">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 76 }} />
            ))}
          </div>
        </Panel>
      ) : null}

      {galleries && galleries.length === 0 && !folders.length ? (
        <Panel>
          <EmptyState
            icon="image"
            title="No galleries yet"
            action={
              <Button icon="refresh" onClick={rescan} loading={scanning}>
                Check for new photos
              </Button>
            }
          >
            Put exported photos in a folder on the gallery share, for example <span className="mono">2026/2026-11-14 Family - Smith Family/Gallery</span>. New folders appear here within a minute or two.
          </EmptyState>
        </Panel>
      ) : null}

      {galleries && galleries.length ? (
        <Panel>
          <ul className="gl-list">
            {galleries.map((g) => (
              <li key={g.id}>
                <Link to={g.id} className="gl-row">
                  <div className="gl-thumb" style={g.cover ? { backgroundImage: `url(${g.cover.thumb}), url(${g.cover.placeholder ?? ""})`, backgroundPosition: focalPos(g.coverFocalX, g.coverFocalY) } : undefined}>
                    {!g.cover ? <Icon name="image" /> : null}
                  </div>
                  <div className="gl-main">
                    <b>{g.title}</b>
                    <span className="muted mono">{g.shootFolder}</span>
                  </div>
                  <div className="gl-stats">
                    <span>
                      <Icon name="image" /> {g.photoCount.toLocaleString()}
                    </span>
                    {g.submittedFavorites ? (
                      <span title="Favorite lists sent by clients">
                        <Icon name="heart" /> {g.submittedFavorites}
                      </span>
                    ) : null}
                  </div>
                  <div className="gl-status">
                    {g.sourceMissing ? <StatusChip tone="bad">Folder missing</StatusChip> : null}
                    {g.processing ? <StatusChip tone="info" pulse>Preparing {g.processing}</StatusChip> : null}
                    <StatusChip tone={g.status === "live" ? "ok" : "neutral"}>{g.status === "live" ? "Shared" : g.status === "archived" ? "Archived" : "Draft"}</StatusChip>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}
