import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Icon, Spinner } from "@openportrait/ui";
import { formatBytes, isLight, isLocalHost, loadBg, parseBg, photoUrl, saveBg, useTether, type TetherPhoto } from "../../lib/tether.js";
import { BackgroundPicker } from "./BackgroundPicker.js";
import "./tether.css";

type Shown = { photo: TetherPhoto; failed: boolean };

/** The full-screen view: one photo, as large as the screen allows, replaced the moment the next one lands. */
export function TetherLivePage() {
  const { source = "incoming" } = useParams();
  const [search, setSearch] = useSearchParams();
  const bg = parseBg(search.get("bg")) ?? loadBg();
  const light = isLight(bg);

  const [shown, setShown] = useState<Shown | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const tether = useTether(source);
  const { current, markShown } = tether;
  const [chromeVisible, setChromeVisible] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const setBg = useCallback(
    (hex: string) => {
      saveBg(hex);
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("bg", hex.slice(1));
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  // Preload each new photo, then swap it in, so the screen never goes blank between frames.
  useEffect(() => {
    if (!current) return;
    const { photo } = current;
    if (shown?.photo.id === photo.id && shown.photo.at === photo.at) return;
    setLoadingId(photo.id);
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      setShown({ photo, failed: false });
      setLoadingId(null);
      markShown(photo);
    };
    img.onerror = () => {
      if (cancelled) return;
      setShown({ photo, failed: true });
      setLoadingId(null);
      markShown(photo);
    };
    img.src = photoUrl(source, photo);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.photo.id, current?.photo.at, source]);

  // Controls fade away while you shoot and return on any movement.
  const wake = useCallback(() => {
    setChromeVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChromeVisible(false), 3500);
  }, []);
  useEffect(() => {
    wake();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [wake]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      /* some browsers refuse; the page is still usable without it */
    }
  }, []);
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input")) return;
      wake();
      if (e.key === "f" || e.key === "F") void toggleFullscreen();
      if (e.key === "b" || e.key === "B") setBg(light ? "#000000" : "#ffffff");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wake, toggleFullscreen, setBg, light]);

  const up = tether.uploading;
  const lead = up[0];
  const local = isLocalHost(window.location.hostname);
  const live = tether.conn === "live";
  const pingTone = tether.ping === null ? "" : tether.ping < 80 ? "good" : tether.ping < 250 ? "fair" : "slow";
  const showChrome = chromeVisible || panelOpen || up.length > 0 || !live;

  return (
    <div
      ref={root}
      className={`tether ${light ? "on-light" : "on-dark"}${showChrome ? "" : " calm"}`}
      style={{ background: bg }}
      onPointerMove={wake}
      onPointerDown={wake}
      data-testid="tether-live"
    >
      <main className="tether-stage" aria-live="polite">
        {shown && !shown.failed && <img key={`${shown.photo.id}-${shown.photo.at}`} className="tether-photo" src={photoUrl(source, shown.photo)} alt={`Latest photo: ${shown.photo.name}`} draggable={false} />}
        {shown?.failed && (
          <div className="tether-note" key={shown.photo.id}>
            <Icon name="image" />
            <b>{shown.photo.name}</b>
            <span>This file arrived, but it has no preview that can be shown here.</span>
          </div>
        )}
        {!shown && !tether.error && (
          <div className="tether-note" role="status">
            {live && tether.folderReady ? (
              <>
                <span className="tether-pulse" aria-hidden />
                <b>Waiting for the first photo</b>
                <span>Shoot from your camera. Each photo appears here as soon as its upload finishes.</span>
              </>
            ) : live ? (
              <>
                <Icon name="folder" />
                <b>Waiting for the folder</b>
                <span>The folder for this set isn&rsquo;t on the server yet. It will be picked up as soon as it appears.</span>
              </>
            ) : (
              <>
                <Spinner label="Connecting" />
                <b>Connecting to {tether.label || "your studio"}…</b>
              </>
            )}
          </div>
        )}
        {loadingId && shown && <span className="tether-loading" role="status" aria-label="Loading the next photo"><Spinner /></span>}
      </main>

      <header className="tether-top" aria-hidden={!showChrome}>
        <div className="tether-title">
          <Link to="/studio/tether" className="tether-btn icon" aria-label="Back to tethering setup" tabIndex={showChrome ? 0 : -1}>
            <Icon name="arrowLeft" />
          </Link>
          <div>
            <b>{tether.label || "Tethering"}</b>
            <span>{tether.total} {tether.total === 1 ? "photo" : "photos"} in this folder</span>
          </div>
        </div>
        <div className="tether-tools">
          <span className={`tether-conn ${live ? "ok" : "warn"}`} role="status">
            <i aria-hidden />
            {live ? "Live" : tether.conn === "connecting" ? "Connecting" : "Reconnecting…"}
            {live && tether.ping !== null && <span className={`ping ${pingTone}`}> · {tether.ping} ms</span>}
            {live && <span className="tether-route"> · {local ? "On your network" : "Via internet"}</span>}
          </span>
          <button type="button" className="tether-btn icon" aria-label="Background colour" aria-expanded={panelOpen} onClick={() => setPanelOpen((v) => !v)} tabIndex={showChrome ? 0 : -1}>
            <span className="swatch" style={{ background: bg }} />
          </button>
          <button type="button" className="tether-btn icon" aria-label={fullscreen ? "Exit full screen" : "Full screen (F)"} onClick={toggleFullscreen} tabIndex={showChrome ? 0 : -1}>
            <Icon name={fullscreen ? "x" : "external"} />
          </button>
        </div>
        {panelOpen && (
          <div className="tether-pop" role="dialog" aria-label="Background colour">
            <BackgroundPicker value={bg} onChange={setBg} />
            <p>Press <kbd>B</kbd> to flip black and white, <kbd>F</kbd> for full screen.</p>
          </div>
        )}
      </header>

      <footer className="tether-bottom" aria-hidden={!showChrome && up.length === 0}>
        {lead ? (
          <div className="tether-activity" role="status">
            <div className="tether-row">
              <b>
                Receiving {lead.name}
                {up.length > 1 && <span> + {up.length - 1} more</span>}
              </b>
              <span className="tether-num">
                {formatBytes(lead.bytes)}
                {lead.rate > 0 && ` · ${formatBytes(lead.rate)}/s`}
                {lead.percent !== null && ` · ~${lead.percent}%`}
              </span>
            </div>
            <div
              className={`tether-bar${lead.percent === null ? " indeterminate" : ""}`}
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={lead.percent ?? undefined}
            >
              <i style={lead.percent === null ? undefined : { width: `${lead.percent}%` }} />
            </div>
          </div>
        ) : (
          <div className="tether-idle">
            {tether.delay !== null && current?.fresh ? <span>Last photo reached the screen {tether.delay < 1000 ? `${tether.delay} ms` : `${(tether.delay / 1000).toFixed(1)} s`} after it landed</span> : <span>Ready for the next photo</span>}
            {!local && live && <span className="tether-hint">Faster at home: open this page from your server&rsquo;s local address.</span>}
          </div>
        )}
      </footer>
    </div>
  );
}
