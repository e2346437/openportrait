import { useEffect, useState } from "react";

export type DownloadLock = "until_paid" | "highlights_early" | "none";
export type DownloadSize = "none" | "web" | "full";

export interface GalleryDesign {
  layout: "full" | "split" | "framed" | "minimal";
  landing: "cards" | "photos" | "set";
  startSetId: string | null;
  nav: "icons" | "text" | "both";
  filenames: boolean;
  grid: "justified" | "masonry" | "square";
  size: "s" | "m" | "l";
  spacing: 0 | 4 | 8 | 18;
  theme: "light" | "dark";
  font: "serif" | "sans";
}

export interface PhotoBase {
  id: string;
  setId: string;
  filename: string;
  width: number | null;
  height: number | null;
  takenAt: number | null;
  placeholder: string | null;
  thumb: string | null;
  preview: string | null;
}

export interface StudioPhoto extends PhotoBase {
  state: "pending" | "ready" | "missing" | "unsupported" | "error";
  error: string | null;
  hidden: boolean;
  relPath: string;
}

export interface StudioSet {
  id: string;
  name: string;
  folderName: string;
  hidden: boolean;
  earlyDownload: boolean;
  coverPhotoId: string | null;
  coverFocalX: number;
  coverFocalY: number;
  sort: number;
}

export interface FavoriteListInfo {
  id: string;
  name: string;
  maxCount: number | null;
}

export interface GalleryDetail {
  gallery: {
    id: string;
    title: string;
    slug: string;
    status: "draft" | "live" | "archived";
    shootFolder: string;
    folderPath: string;
    sourceMissing: boolean;
    coverPhotoId: string | null;
    coverFocalX: number;
    coverFocalY: number;
    design: GalleryDesign;
    downloadSize: DownloadSize;
    downloadLock: DownloadLock;
    accessMode: "link" | "password";
    hasPassword: boolean;
    registration: "none" | "email" | "email_name";
    welcomeMessage: string | null;
    unlockedAt: number | null;
    expiresAt: number | null;
    publishedAt: number | null;
    url: string;
    views: number;
    downloads: number;
  };
  sets: StudioSet[];
  photos: StudioPhoto[];
  lists: FavoriteListInfo[];
  /** People on this gallery's shoot who have an email address. */
  recipients: Array<{ contactId: string | null; name: string; email: string }>;
  emailReady: boolean;
  emails: Array<{ id: string; kind: string; toEmail: string; subject: string; status: "sent" | "failed"; error: string | null; at: number }>;
}

export interface GallerySummary {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "live" | "archived";
  shootFolder: string;
  sourceMissing: boolean;
  photoCount: number;
  processing: number;
  submittedFavorites: number;
  cover: { thumb: string; preview: string; placeholder: string | null } | null;
  coverFocalX: number;
  coverFocalY: number;
  publishedAt: number | null;
  updatedAt: number;
}

export interface InboxFolder {
  id: string;
  relPath: string;
  suggestedTitle: string;
  fileCount: number;
  sampleFiles: string[];
  stable: boolean;
  firstSeenAt: number;
  lastChangeAt: number;
}

export interface Selection {
  id: string;
  listId: string;
  listName: string;
  clientEmail: string;
  submittedAt: number | null;
  items: Array<{ photoId: string; note: string; filename: string }>;
}

/* Client side */

export interface ClientCover {
  id: string;
  thumb: string;
  preview: string;
  placeholder: string | null;
  width: number | null;
  height: number | null;
}

export interface ClientGallery {
  studio: { name: string; email: string; logo: string | null };
  /** Present while the visitor still has to enter a password or register. */
  gate?: { password: boolean; register: "email" | "email_name" | null };
  gallery: {
    title: string;
    slug: string;
    welcomeMessage: string | null;
    preview: boolean;
    design: GalleryDesign;
    cover: ClientCover | null;
    coverFocalX: number;
    coverFocalY: number;
    downloadSize?: DownloadSize;
    downloadLock?: DownloadLock;
    unlocked?: boolean;
    date: number | null;
  };
  sets: Array<{ id: string; name: string; count: number; cover: ClientCover | null; coverFocalX: number; coverFocalY: number; download: { allowed: true } | { allowed: false; reason: "off" | "locked" } }>;
  photos: PhotoBase[];
  lists: FavoriteListInfo[];
  me: ClientMe;
}

export interface ClientMe {
  email: string | null;
  selections: Array<{ listId: string; submittedAt: number | null; photoIds: string[]; notes: Record<string, string> }>;
}

export const LOCK_LABELS: Record<DownloadLock, { title: string; body: string }> = {
  none: { title: "Downloads open now", body: "Clients can download as soon as the gallery is shared." },
  highlights_early: { title: "Highlights now, the rest after payment", body: "Sets you mark “early download” open now; everything else opens once paid." },
  until_paid: { title: "Locked until paid", body: "Clients can view and favorite, and downloads open once the gallery is paid for." },
};

/** "50% 30%" for object-position / background-position from a focal point. */
export const focalPos = (x: number, y: number) => `${x}% ${y}%`;

export function formatDate(ms: number | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  return ms ? new Intl.DateTimeFormat(undefined, opts).format(new Date(ms)) : "";
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return formatDate(ms);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Packs photos into rows of equal height that fill the width (the "justified" grid).
 * The last row keeps the target height instead of stretching.
 */
export function justify<T extends { width: number | null; height: number | null }>(items: T[], containerWidth: number, targetHeight: number, gap: number): Array<{ items: Array<{ item: T; width: number }>; height: number }> {
  const rows: Array<{ items: Array<{ item: T; width: number }>; height: number }> = [];
  if (containerWidth <= 0) return rows;
  let row: T[] = [];
  let aspectSum = 0;
  const ratio = (t: T) => (t.width && t.height ? t.width / t.height : 1.5);
  const flush = (last: boolean) => {
    if (!row.length) return;
    const available = containerWidth - gap * (row.length - 1);
    const height = last ? Math.min(targetHeight, available / aspectSum) : available / aspectSum;
    rows.push({ height, items: row.map((item) => ({ item, width: ratio(item) * height })) });
    row = [];
    aspectSum = 0;
  };
  for (const item of items) {
    row.push(item);
    aspectSum += ratio(item);
    if (aspectSum * targetHeight + gap * (row.length - 1) >= containerWidth) flush(false);
  }
  flush(true);
  return rows;
}

/** Width of an element, kept up to date. */
export function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    // The usable width excludes the element's own padding.
    const measure = () => {
      const cs = getComputedStyle(el);
      setW(Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

export const ROW_HEIGHT = { s: 180, m: 260, l: 360 } as const;
export const COLUMN_WIDTH = { s: 200, m: 280, l: 380 } as const;
