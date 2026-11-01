import { useRef, useState, type PointerEvent } from "react";
import { Button, Icon, Panel, Segmented } from "@openportrait/ui";
import { focalPos, type GalleryDesign, type GalleryDetail } from "../../lib/galleries.js";
import type { Patch } from "./GalleryDetail.js";

const LAYOUTS: Array<{ id: GalleryDesign["layout"]; label: string; sketch: string }> = [
  { id: "full", label: "Full photo", sketch: '<rect width="60" height="40" fill="#8a8378"/><rect x="6" y="28" width="26" height="4" fill="#fff"/>' },
  { id: "split", label: "Split", sketch: '<rect width="60" height="40" fill="#e6e0d5"/><rect x="26" width="34" height="40" fill="#8a8378"/><rect x="5" y="28" width="16" height="4" fill="#555"/>' },
  { id: "framed", label: "Framed", sketch: '<rect width="60" height="40" fill="#e6e0d5"/><rect x="6" y="4" width="48" height="25" fill="#8a8378"/><rect x="19" y="33" width="22" height="3" fill="#555"/>' },
  { id: "minimal", label: "Text only", sketch: '<rect width="60" height="40" fill="#e6e0d5"/><rect x="6" y="16" width="30" height="5" fill="#555"/>' },
];

type Target = { kind: "gallery" } | { kind: "set"; id: string };

/** Cover photo, focal point and presentation, as in Sprout's gallery design (docs/GALLERIES.md section 6.2a). */
export function DesignTab({ data, patch }: { data: GalleryDetail; patch: Patch }) {
  const { gallery: g, sets, photos } = data;
  const design = g.design;
  const ready = photos.filter((p) => p.state === "ready" && !p.hidden);
  const [target, setTarget] = useState<Target>({ kind: "gallery" });
  const set = target.kind === "set" ? sets.find((s) => s.id === target.id) ?? null : null;
  const coverId = set ? set.coverPhotoId : g.coverPhotoId;
  const cover = photos.find((p) => p.id === coverId) ?? null;
  const fx = set ? set.coverFocalX : g.coverFocalX;
  const fy = set ? set.coverFocalY : g.coverFocalY;
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const pos = live ?? { x: fx, y: fy };
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const save = (body: object) => (set ? patch(`/sets/${set.id}`, body) : patch("", body));
  const choose = (photoId: string) => save({ coverPhotoId: photoId, coverFocalX: 50, coverFocalY: 50 });
  const setDesign = (d: Partial<GalleryDesign>) => patch("", { design: d });

  const move = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
    const y = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)));
    setLive({ x, y });
  };
  const commit = async () => {
    dragging.current = false;
    if (live) await save({ coverFocalX: live.x, coverFocalY: live.y });
    setLive(null);
  };
  const nudge = (dx: number, dy: number) => save({ coverFocalX: Math.min(100, Math.max(0, pos.x + dx)), coverFocalY: Math.min(100, Math.max(0, pos.y + dy)) });

  const bg = (url: string | null | undefined) => (url ? { backgroundImage: `url(${url})`, backgroundPosition: focalPos(pos.x, pos.y) } : undefined);

  return (
    <div className="design">
      <div className="col">
        <Panel
          title="Cover photo"
          description="Pick the photo, then click or drag on it to choose the point that stays in view when it's cropped for the cover, set cards, and phones."
          actions={
            <Segmented
              label="What to edit"
              value={target.kind === "gallery" ? "gallery" : target.id}
              onChange={(v) => setTarget(v === "gallery" ? { kind: "gallery" } : { kind: "set", id: v })}
              options={[{ value: "gallery", label: "Gallery" }, ...sets.filter((s) => !s.hidden).map((s) => ({ value: s.id, label: s.name }))]}
            />
          }
        >
          {cover?.preview ? (
            <div
              ref={box}
              className="focal"
              onPointerDown={(e) => {
                dragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                move(e);
              }}
              onPointerMove={(e) => dragging.current && move(e)}
              onPointerUp={commit}
              onPointerCancel={() => {
                dragging.current = false;
                setLive(null);
              }}
              role="slider"
              tabIndex={0}
              aria-label="Focal point of the cover photo"
              aria-valuetext={`${pos.x}% across, ${pos.y}% down`}
              onKeyDown={(e) => {
                const d = e.shiftKey ? 10 : 2;
                if (e.key === "ArrowLeft") nudge(-d, 0);
                else if (e.key === "ArrowRight") nudge(d, 0);
                else if (e.key === "ArrowUp") nudge(0, -d);
                else if (e.key === "ArrowDown") nudge(0, d);
                else return;
                e.preventDefault();
              }}
            >
              <img src={cover.preview} alt="" draggable={false} />
              <span className="hair" style={{ left: `${pos.x}%`, top: 0, bottom: 0, width: 1 }} />
              <span className="hair" style={{ top: `${pos.y}%`, left: 0, right: 0, height: 1 }} />
              <span className="dot" style={{ left: `${pos.x}%`, top: `${pos.y}%` }} />
            </div>
          ) : (
            <p className="muted">No cover yet. Choose a photo below.</p>
          )}
          <div className="crops" aria-label="How the cover crops">
            <div className="crop">
              <div style={{ aspectRatio: "16 / 7", ...bg(cover?.preview) }} />
              <span>Cover on desktop</span>
            </div>
            <div className="crop">
              <div style={{ aspectRatio: "4 / 3", ...bg(cover?.preview) }} />
              <span>Set card</span>
            </div>
            <div className="crop">
              <div style={{ aspectRatio: "9 / 16", ...bg(cover?.preview) }} />
              <span>Phone</span>
            </div>
          </div>
          {set ? (
            <Button size="sm" variant="ghost" onClick={() => save({ coverPhotoId: null })}>
              Use the first photo
            </Button>
          ) : null}
          <div>
            <div className="label">Choose a photo</div>
            {ready.length === 0 ? (
              <p className="muted">Photos appear here once their previews are ready.</p>
            ) : (
              <div className="picks">
                {(set ? ready.filter((p) => p.setId === set.id) : ready).slice(0, 200).map((p) => (
                  <button key={p.id} type="button" aria-pressed={p.id === coverId} aria-label={`Use ${p.filename}`} style={{ backgroundImage: `url(${p.thumb})` }} onClick={() => choose(p.id)} />
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>

      <div className="col">
        <Panel title="Cover layout">
          <div className="layouts" role="radiogroup" aria-label="Cover layout">
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={design.layout === l.id} className="lay" aria-pressed={design.layout === l.id} onClick={() => setDesign({ layout: l.id })}>
                <svg className="sk" viewBox="0 0 60 40" aria-hidden="true" dangerouslySetInnerHTML={{ __html: l.sketch }} />
                {l.label}
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Gallery page">
          <div className="dopts">
            <span className="label">First page shows</span>
            <Segmented label="First page shows" value={design.landing} onChange={(v) => setDesign({ landing: v })} options={[{ value: "cards", label: "Set cards" }, { value: "photos", label: "All photos" }]} />
            <span className="label">Photo grid</span>
            <Segmented label="Photo grid" value={design.grid} onChange={(v) => setDesign({ grid: v })} options={[{ value: "justified", label: "Rows" }, { value: "masonry", label: "Columns" }, { value: "square", label: "Squares" }]} />
            <span className="label">Photo size</span>
            <Segmented label="Photo size" value={design.size} onChange={(v) => setDesign({ size: v })} options={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }]} />
            <span className="label">Spacing</span>
            <Segmented label="Spacing" value={design.spacing} onChange={(v) => setDesign({ spacing: v })} options={[{ value: 0, label: "None" }, { value: 4, label: "Tight" }, { value: 8, label: "Normal" }, { value: 18, label: "Wide" }]} />
            <span className="label">Theme</span>
            <Segmented label="Theme" value={design.theme} onChange={(v) => setDesign({ theme: v })} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
            <span className="label">Titles</span>
            <Segmented label="Titles" value={design.font} onChange={(v) => setDesign({ font: v })} options={[{ value: "serif", label: "Serif" }, { value: "sans", label: "Sans" }]} />
          </div>
          <a className="btn" href={`/g/${g.slug}`} target="_blank" rel="noreferrer">
            <Icon name="external" /> See it as a client
          </a>
        </Panel>
      </div>
    </div>
  );
}
