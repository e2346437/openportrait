import { useEffect, useState } from "react";
import { Button, Callout, Dialog, EmptyState, Icon, Spinner } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";
import type { PickPhoto } from "../../lib/site.js";

interface Library {
  galleries: Array<{ id: string; title: string; status: string; photoCount: number }>;
}

/**
 * Choose photos from the studio's galleries for the website. Nothing is public until the site is uploaded, and only
 * the photos picked here are ever included.
 */
export function PhotoPicker({ open, multiple, selected, title, onClose, onDone }: { open: boolean; multiple: boolean; selected: string[]; title: string; onClose: () => void; onDone: (ids: string[]) => void }) {
  const lib = useLoad<Library>(open ? "/site/library" : null);
  const [galleryId, setGalleryId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(selected);
  const [photos, setPhotos] = useState<PickPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPicked(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && !galleryId && lib.data?.galleries[0]) setGalleryId(lib.data.galleries[0].id);
  }, [open, lib.data, galleryId]);

  useEffect(() => {
    if (!open || !galleryId) return;
    let live = true;
    setPhotos(null);
    setError(null);
    api<{ photos: PickPhoto[] }>(`/site/library/${galleryId}`)
      .then((r) => live && setPhotos(r.photos))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, galleryId]);

  const toggle = (id: string) => setPicked((cur) => (multiple ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur[0] === id ? [] : [id]));
  const visible = photos?.map((p) => p.id) ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={title}
      description="Photos you pick are copied to your website at web size, with camera data removed. Photos of clients become public when you upload the site, so only pick ones you have permission to show."
      footer={
        <>
          <span className="muted push-left">{multiple ? `${picked.length} selected` : picked.length ? "1 selected" : "None selected"}</span>
          {multiple && visible.length ? (
            <Button variant="ghost" onClick={() => setPicked((cur) => [...new Set([...cur, ...visible])])}>
              Select all in this gallery
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onDone(picked)}>
            Use {multiple ? "these photos" : "this photo"}
          </Button>
        </>
      }
    >
      {lib.loading && !lib.data ? (
        <div className="detail-loading"><Spinner label="Loading galleries" /></div>
      ) : lib.error ? (
        <Callout tone="bad">{lib.error}</Callout>
      ) : !lib.data?.galleries.length ? (
        <EmptyState icon="image" title="No photos yet">Add photos to a gallery first. They can be picked here as soon as their previews are ready.</EmptyState>
      ) : (
        <div className="wb-picker">
          <div className="wb-gals" role="listbox" aria-label="Galleries">
            {lib.data.galleries.map((g) => (
              <button key={g.id} type="button" role="option" aria-selected={g.id === galleryId} onClick={() => setGalleryId(g.id)}>
                <b>{g.title}</b>
                <span>{g.photoCount} photos{g.status === "draft" ? " · draft" : ""}</span>
              </button>
            ))}
          </div>
          <div className="wb-pgrid-wrap">
            {error ? <Callout tone="bad">{error}</Callout> : !photos ? <div className="detail-loading"><Spinner label="Loading photos" /></div> : (
              <div className="wb-pgrid">
                {photos.map((p) => {
                  const on = picked.includes(p.id);
                  return (
                    <button key={p.id} type="button" className="wb-pcell" aria-pressed={on} onClick={() => toggle(p.id)} title={p.filename}>
                      {p.thumb ? <img src={p.thumb} alt={p.filename ?? ""} loading="lazy" /> : null}
                      <span className="tick">{on ? <Icon name="check" /> : null}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
