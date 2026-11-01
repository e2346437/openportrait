import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "@openportrait/ui";
import type { PhotoBase } from "../lib/galleries.js";

interface Props<P extends PhotoBase> {
  photos: P[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Buttons along the bottom (favorite, note, download). */
  actions?: (photo: P) => ReactNode;
  overlay?: (photo: P) => ReactNode;
  /** True while a dialog is open over the lightbox, so Escape and arrows belong to it. */
  paused?: boolean;
}

/** Full-screen photo viewer. Always dark so photos read true; arrows, Escape and swipes work. */
export function Lightbox<P extends PhotoBase>({ photos, index, onIndex, onClose, actions, overlay, paused }: Props<P>) {
  const photo = photos[index];
  const closeRef = useRef<HTMLButtonElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = (d: number) => onIndex((index + d + photos.length) % photos.length);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Warm the cache for the neighbours so paging feels instant.
  useEffect(() => {
    for (const d of [1, -1]) {
      const p = photos[(index + d + photos.length) % photos.length];
      if (p?.preview) new Image().src = p.preview;
    }
  }, [index, photos]);

  if (!photo) return null;
  return (
    <div className="lb" role="dialog" aria-modal="true" aria-label={`Photo ${index + 1} of ${photos.length}`}>
      <div className="lb-top">
        <span className="pos">
          {index + 1} / {photos.length}
        </span>
        <button ref={closeRef} type="button" className="lbx" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div
        className="lb-stage"
        onTouchStart={(e) => (touch.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY })}
        onTouchEnd={(e) => {
          const t = touch.current;
          touch.current = null;
          if (!t) return;
          const dx = e.changedTouches[0]!.clientX - t.x;
          const dy = e.changedTouches[0]!.clientY - t.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
        }}
      >
        {photos.length > 1 ? (
          <button type="button" className="lb-nav prev" onClick={() => go(-1)} aria-label="Previous photo">
            <Icon name="chevronLeft" />
          </button>
        ) : null}
        <div className="lb-img">
          {photo.preview ? <img key={photo.id} src={photo.preview} alt={photo.filename} draggable={false} /> : null}
          {overlay?.(photo)}
        </div>
        {photos.length > 1 ? (
          <button type="button" className="lb-nav next" onClick={() => go(1)} aria-label="Next photo">
            <Icon name="chevronRight" />
          </button>
        ) : null}
      </div>
      <div className="lb-bot">{actions?.(photo)}</div>
    </div>
  );
}
