import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Callout, CopyValue, Dialog, EmptyState, Icon, PageHeader, Spinner, StatusChip, Tabs, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { LOCK_LABELS, plural, type DownloadLock, type GalleryDetail } from "../../lib/galleries.js";
import { EmailDialog } from "../../galleries/EmailDialog.js";
import { DesignTab } from "./DesignTab.js";
import { FavoritesTab } from "./FavoritesTab.js";
import { PhotosTab } from "./PhotosTab.js";
import { SettingsTab } from "./SettingsTab.js";

export type Reload = (next?: GalleryDetail) => void;
export type Patch = (path: string, body: unknown, method?: string) => Promise<GalleryDetail | undefined>;

type TabId = "photos" | "design" | "favorites" | "settings";

export function GalleryDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<GalleryDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [defaultLock, setDefaultLock] = useState<DownloadLock>("none");
  const tab = (params.get("tab") as TabId | null) ?? "photos";

  const load = useCallback(
    async (next?: GalleryDetail) => {
      if (next) return setData(next);
      try {
        setData(await api<GalleryDetail>(`/galleries/${id}`));
        setError(null);
      } catch (e) {
        const err = e as { status?: number; message: string };
        setError({ status: err.status ?? 0, message: err.message });
      }
    },
    [id],
  );

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const pending = data?.photos.filter((p) => p.state === "pending").length ?? 0;
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [pending, load]);

  /** Sends a change and swaps in the fresh gallery; errors show as a toast. */
  const patch: Patch = useCallback(
    async (path, body, method = "PATCH") => {
      try {
        const next = await api<GalleryDetail>(`/galleries/${id}${path}`, { method, body });
        setData(next);
        return next;
      } catch (e) {
        toast((e as Error).message, "bad");
        return undefined;
      }
    },
    [id, toast],
  );

  const openPublish = async () => {
    try {
      const s = await api<{ defaultDownloadLock: DownloadLock }>("/ingest/settings");
      setDefaultLock(data?.gallery.publishedAt ? data.gallery.downloadLock : s.defaultDownloadLock);
    } catch {
      /* keep the current default */
    }
    setPublishing(true);
  };

  if (error) {
    return (
      <>
        <Link to="/studio/galleries" className="back">
          <Icon name="arrowLeft" /> Galleries
        </Link>
        <Callout tone="bad" title={error.status === 404 ? "Gallery not found" : "Couldn't load this gallery"} action={error.status === 404 ? undefined : <Button size="sm" onClick={() => load()}>Try again</Button>}>
          {error.message}
        </Callout>
      </>
    );
  }
  if (!data) {
    return (
      <div className="detail-loading" aria-busy="true" aria-label="Loading gallery">
        <Spinner />
      </div>
    );
  }

  // With no public address set yet, the server sends a relative link; use the address this page was opened from.
  const g = { ...data.gallery, url: new URL(data.gallery.url, window.location.origin).href };
  const live = g.status === "live";
  const counts = { photos: data.photos.filter((p) => p.state !== "missing").length };

  return (
    <>
      <Link to="/studio/galleries" className="back">
        <Icon name="arrowLeft" /> Galleries
      </Link>
      <PageHeader
        title={
          <span className="dh-title">
            {g.title} <StatusChip tone={live ? "ok" : "neutral"}>{live ? "Shared" : "Draft"}</StatusChip>
          </span>
        }
        description={
          <span className="dh-meta">
            <span className="path mono">{g.shootFolder}</span>
            <span>{plural(counts.photos, "photo")}</span>
            {live ? (
              <span>
                {plural(g.views, "visit")} · {plural(g.downloads, "download")}
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            <a className="btn" href={`/g/${g.slug}`} target="_blank" rel="noreferrer">
              <Icon name="external" /> {live ? "View" : "Preview"}
            </a>
            {live ? (
              <Button icon="mail" onClick={() => setEmailing(true)}>
                Email client
              </Button>
            ) : null}
            {live ? (
              <Button
                onClick={async () => {
                  if (await patch("/unpublish", {}, "POST")) toast("Gallery is private again");
                }}
              >
                Stop sharing
              </Button>
            ) : null}
            <Button variant="primary" icon="send" onClick={openPublish} disabled={counts.photos === 0 || pending === counts.photos}>
              {live ? "Sharing options" : "Share with client"}
            </Button>
          </>
        }
      />

      {g.sourceMissing ? (
        <Callout tone="bad" title="This gallery's folder can't be found">
          It was moved, renamed or deleted on the share. Favorites and history are kept. Put the folder back as <span className="mono">{g.shootFolder}</span> and it reconnects on the next check.
        </Callout>
      ) : null}
      {pending ? (
        <Callout tone="info" title={`Preparing ${plural(pending, "photo")}`}>
          Thumbnails and previews are being made. You can keep working; they appear as they finish.
        </Callout>
      ) : null}

      <Tabs
        label="Gallery sections"
        value={tab}
        onChange={(t) => setParams(t === "photos" ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: "photos", label: "Photos", icon: "image", count: counts.photos },
          { id: "design", label: "Design", icon: "palette" },
          { id: "favorites", label: "Favorites", icon: "heart" },
          { id: "settings", label: "Settings", icon: "gear" },
        ]}
      />
      <div role="tabpanel">
        {tab === "photos" ? <PhotosTab data={data} patch={patch} reload={load} /> : null}
        {tab === "design" ? <DesignTab data={data} patch={patch} /> : null}
        {tab === "favorites" ? <FavoritesTab data={data} patch={patch} /> : null}
        {tab === "settings" ? <SettingsTab data={{ ...data, gallery: g }} patch={patch} onDeleted={() => navigate("/studio/galleries")} /> : null}
      </div>

      <EmailDialog open={emailing} onClose={() => setEmailing(false)} galleryId={g.id} />

      <PublishDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        live={live}
        url={g.url}
        initial={defaultLock}
        onPublish={async (lock) => {
          const next = await patch("/publish", { downloadLock: lock }, "POST");
          if (next) toast(live ? "Sharing options saved" : "Gallery is shared");
          return !!next;
        }}
      />
    </>
  );
}

function PublishDialog({ open, onClose, live, url, initial, onPublish }: { open: boolean; onClose: () => void; live: boolean; url: string; initial: DownloadLock; onPublish: (lock: DownloadLock) => Promise<boolean> }) {
  const [lock, setLock] = useState<DownloadLock>(initial);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setLock(initial);
      setDone(false);
    }
    wasOpen.current = open;
  }, [open, initial]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={done ? "Your gallery is shared" : live ? "Sharing options" : "Share this gallery"}
      description={done ? "Anyone with this link can view it. Clients give their email when they first favorite or download." : "Anyone with the link can view. Choose when clients can download."}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onPublish(lock);
                setBusy(false);
                if (ok) setDone(true);
              }}
            >
              {live ? "Save" : "Share"}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <CopyValue value={url} label="gallery link" />
      ) : (
        <fieldset className="opts">
          <legend className="sr-only">When can clients download?</legend>
          {(Object.keys(LOCK_LABELS) as DownloadLock[]).map((k) => (
            <label key={k} className="opt">
              <input type="radio" name="lock" checked={lock === k} onChange={() => setLock(k)} />
              <span className="t">
                <b>{LOCK_LABELS[k].title}</b>
                <span>{LOCK_LABELS[k].body}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </Dialog>
  );
}

export { EmptyState };
