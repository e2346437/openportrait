import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Icon, Spinner } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { formatBytes, isLight, isLocalHost, loadBg, parseBg, photoUrl, saveBg, useTether, type TetherPhoto } from "../../lib/tether.js";
import { BackgroundPicker } from "./BackgroundPicker.js";
import { DaySession } from "./DaySession.js";
import "./tether.css";

type Shown = { photo: TetherPhoto; failed: boolean };

/** The full-screen view: one photo, as large as the screen allows, replaced the moment the next one lands. */
export function TetherLivePage() {
  const { source = "incoming" } = useParams();
  const [search, setSearch] = useSearchParams();
  const bg = parseBg(search.get("bg")) ?? loadBg();
  const day = source === "incoming" ? search.get("day") : null;
  const light = isLight(bg);

  const [shown, setShown] = useState<Shown | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const tether = useTether(source);
  const { current, markShown } = tether;
  // Browsing: null follows the newest photo; an id holds the screen on an earlier one while new photos keep arriving.
  const [pinned, setPinned] = useState<string | null>(null);
  const [history, setHistory] = useState<TetherPhoto[]>([]);
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

  useEffect(() => {
    let stop = false;
    void api<{ photos: TetherPhoto[] }>(`/tether/${encodeURIComponent(source)}/list`)
      .then((r) => !stop && setHistory(r.photos))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [source, tether.total, current?.photo.id, tether.conn]);
  useEffect(() => setPinned(null), [source]);

  const pinnedPhoto = pinned ? history.find((p) => p.id === pinned) ?? null : null;
  const target = pinnedPhoto ?? current?.photo ?? null;
  const at = target ? history.findIndex((p) => p.id === target.id) : -1;
  const behind = !!pinnedPhoto && !!current && current.photo.id !== pinnedPhoto.id;
  const step = (d: -1 | 1) => {
    const next = history[at + d];
    if (!next) return;
    setPinned(next.id === history[history.length - 1]?.id ? null : next.id);
  };

  // Preload each new photo, then swap it in, so the screen never goes blank between frames.
  useEffect(() => {
    if (!target) {
      setShown(null);
      return;
    }
    const photo = target;
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
  }, [target?.id, target?.at, source]);

  // Deleting can't be undone, so the first tap asks and the second (within a few seconds) does it.
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirming]);
  useEffect(() => setConfirming(false), [shown?.photo.id]);
  const deleteShown = async () => {
    if (!shown) return;
    if (!confirming) return setConfirming(true);
    setDeleting(true);
    try {
      await api(`/tether/${encodeURIComponent(source)}/photo?path=${encodeURIComponent(shown.photo.id)}`, { method: "DELETE" });
      const neighbour = history[at - 1] ?? history[at + 1] ?? null;
      setPinned(pinned && neighbour && neighbour.id !== history[history.length - 1]?.id ? neighbour.id : null);
      setShown(null);
    } catch {
      /* the photo stays on screen, which tells you it wasn't deleted */
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

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
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      wake();
      if (e.key === "f" || e.key === "F") void toggleFullscreen();
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
      if (e.key === "b" || e.key === "B") setBg(light ? "#000000" : "#ffffff");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wake, toggleFullscreen, setBg, light, history, at]);

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
        {history.length > 1 ? (
          <>
            <button type="button" className="tether-btn icon tether-nav prev" aria-label="Previous photo (left arrow)" onClick={() => step(-1)} disabled={at <= 0}>
              <Icon name="chevronLeft" />
            </button>
            <button type="button" className="tether-btn icon tether-nav next" aria-label="Next photo (right arrow)" onClick={() => step(1)} disabled={at < 0 || at >= history.length - 1}>
              <Icon name="chevronRight" />
            </button>
          </>
        ) : null}
        {behind ? (
          <button type="button" className="tether-btn tether-latest" onClick={() => setPinned(null)}>
            New photo arrived · Jump to latest
          </button>
        ) : null}
        {loadingId && shown && <span className="tether-loading" role="status" aria-label="Loading the next photo"><Spinner /></span>}
      </main>

      <header className="tether-top" aria-hidden={!showChrome}>
        <div className="tether-title">
          <Link to="/studio/tether" className="tether-btn icon" aria-label="Back to tethering setup" tabIndex={showChrome ? 0 : -1}>
            <Icon name="arrowLeft" />
          </Link>
          <div>
            <b>{tether.label || "Tethering"}</b>
            <span>{at >= 0 ? `${at + 1} of ${history.length}` : `${tether.total} ${tether.total === 1 ? "photo" : "photos"}`} in this folder</span>
          </div>
        </div>
        <div className="tether-tools">
          <span className={`tether-conn ${live ? "ok" : "warn"}`} role="status">
            <i aria-hidden />
            {live ? "Live" : tether.conn === "connecting" ? "Connecting" : "Reconnecting…"}
            {live && tether.ping !== null && <span className={`ping ${pingTone}`}> · {tether.ping} ms</span>}
            {live && <span className="tether-route"> · {local ? "On your network" : "Via internet"}</span>}
          </span>
          {shown ? (
            <button type="button" className={`tether-btn del${confirming ? " sure" : ""}`} aria-label={confirming ? "Tap again to delete this photo for good" : "Delete this photo"} onClick={deleteShown} disabled={deleting} tabIndex={showChrome ? 0 : -1}>
              <Icon name="trash" />
              {confirming ? <span>Delete for good?</span> : null}
            </button>
          ) : null}
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

      {day ? <DaySession day={day} shown={shown?.photo ?? null} history={history} visible={showChrome} onActivity={wake} /> : null}

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
