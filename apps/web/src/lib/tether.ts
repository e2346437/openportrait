import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export interface TetherPhoto {
  id: string;
  name: string;
  size: number;
  at: number;
}
export interface TetherUploading {
  id: string;
  name: string;
  bytes: number;
  rate: number;
  percent: number | null;
}
export interface TetherSources {
  incoming: { label: string; description: string };
  shoots: Array<{ id: string; subject: string; shootType: string; client: string; startsAt: string | number | null }>;
  lan: { addresses: string[]; port: number };
}

// ---- background colour ----

export const HEX = /^#?([0-9a-f]{6})$/i;

/** Accepts "black", "white", "c2461f" or "#C2461F" and returns a lowercase "#rrggbb", or null. */
export function parseBg(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().toLowerCase();
  if (v === "black") return "#000000";
  if (v === "white") return "#ffffff";
  const m = HEX.exec(v);
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/** True when text on this background should be dark. Uses WCAG relative luminance. */
export function isLight(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

const BG_KEY = "openportrait.tether.bg";
export function loadBg(): string {
  try {
    return parseBg(localStorage.getItem(BG_KEY)) ?? "#000000";
  } catch {
    return "#000000";
  }
}
export function saveBg(hex: string) {
  try {
    localStorage.setItem(BG_KEY, hex);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

/** The live view's link. The colour rides in the query so a bookmarked link keeps its look. */
export function liveLink(origin: string, source: string, bg: string): string {
  return `${origin.replace(/\/+$/, "")}/studio/tether/${encodeURIComponent(source)}?bg=${bg.slice(1)}`;
}

export function photoUrl(source: string, photo: TetherPhoto): string {
  return `/api/studio/tether/${encodeURIComponent(source)}/photo?path=${encodeURIComponent(photo.id)}&v=${photo.at}-${photo.size}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

/** Hostnames that mean "the browser is on the same network as the server". */
export function isLocalHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || (!host.includes(".") && !host.includes(":"));
}

// ---- the live stream ----

export type TetherConn = "connecting" | "live" | "reconnecting";

export interface TetherState {
  conn: TetherConn;
  label: string;
  folderReady: boolean;
  total: number;
  /** The newest photo, and whether it arrived while watching (true) or was already there (false). */
  current: { photo: TetherPhoto; fresh: boolean } | null;
  uploading: TetherUploading[];
  /** Round-trip time to the server in ms. */
  ping: number | null;
  /** How long the last fresh photo took from landing to being on screen, in ms. */
  delay: number | null;
  error: string | null;
}

/** Subscribes to a source's event stream and keeps a ping measurement going. */
export function useTether(source: string, onPhotoShown?: () => void): TetherState & { markShown(photo: TetherPhoto): void } {
  const [state, setState] = useState<TetherState>({ conn: "connecting", label: "", folderReady: true, total: 0, current: null, uploading: [], ping: null, delay: null, error: null });
  const clockSkew = useRef(0);
  const cb = useRef(onPhotoShown);
  cb.current = onPhotoShown;

  useEffect(() => {
    setState((s) => ({ ...s, conn: "connecting", current: null, uploading: [], total: 0, error: null }));
    const es = new EventSource(`/api/studio/tether/${encodeURIComponent(source)}/events`);
    const read = <T,>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
    es.addEventListener("hello", (e) => {
      const d = read<{ label: string; folderReady: boolean; latest: TetherPhoto | null; total: number; uploading: TetherUploading[]; now: number }>(e);
      clockSkew.current = d.now - Date.now();
      setState((s) => ({ ...s, conn: "live", label: d.label, folderReady: d.folderReady, total: d.total, uploading: d.uploading, current: d.latest ? { photo: d.latest, fresh: false } : null }));
    });
    es.addEventListener("progress", (e) => setState((s) => ({ ...s, uploading: read<{ uploading: TetherUploading[] }>(e).uploading })));
    es.addEventListener("photo", (e) => {
      const p = read<TetherPhoto & { total: number }>(e);
      setState((s) => ({ ...s, total: p.total, current: { photo: p, fresh: true } }));
    });
    es.addEventListener("folder", (e) => setState((s) => ({ ...s, folderReady: read<{ folderReady: boolean }>(e).folderReady })));
    es.onopen = () => setState((s) => ({ ...s, conn: "live" }));
    es.onerror = () => setState((s) => ({ ...s, conn: "reconnecting" }));
    return () => es.close();
  }, [source]);

  // Round-trip time: the median of the last five pings, so one slow packet doesn't make the number jump.
  useEffect(() => {
    const samples: number[] = [];
    let stop = false;
    const measure = async () => {
      const t0 = performance.now();
      try {
        await api("/tether/ping");
        samples.push(performance.now() - t0);
        if (samples.length > 5) samples.shift();
        const sorted = [...samples].sort((a, b) => a - b);
        if (!stop) setState((s) => ({ ...s, ping: Math.round(sorted[Math.floor(sorted.length / 2)]!) }));
      } catch {
        if (!stop) setState((s) => ({ ...s, ping: null }));
      }
    };
    void measure();
    const id = window.setInterval(measure, 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const markShown = (photo: TetherPhoto) => {
    const shownAt = Date.now() + clockSkew.current;
    setState((s) => (s.current?.photo.id === photo.id && s.current.fresh ? { ...s, delay: Math.max(0, shownAt - photo.at) } : s));
    cb.current?.();
  };
  return { ...state, markShown };
}
