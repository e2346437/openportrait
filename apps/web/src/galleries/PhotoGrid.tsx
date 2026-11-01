import { useState, type CSSProperties, type ReactNode } from "react";
import { COLUMN_WIDTH, justify, ROW_HEIGHT, useWidth, type GalleryDesign, type PhotoBase } from "../lib/galleries.js";

interface Props<P extends PhotoBase> {
  photos: P[];
  design: Pick<GalleryDesign, "grid" | "size" | "spacing">;
  onOpen: (photo: P) => void;
  /** Buttons drawn over a tile (favorite, download). */
  actions?: (photo: P) => ReactNode;
  /** Extra content over a tile, e.g. a watermark. */
  overlay?: (photo: P) => ReactNode;
}

/** The client photo grid in its three styles: justified rows, masonry columns, or squares. */
export function PhotoGrid<P extends PhotoBase>({ photos, design, onOpen, actions, overlay }: Props<P>) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const width = useWidth(el);
  const gap = design.spacing;
  const narrow = width > 0 && width < 600;

  const tile = (p: P, style?: CSSProperties) => (
    <div key={p.id} className="tile" style={{ ...style, backgroundImage: p.placeholder ? `url(${p.placeholder})` : undefined }}>
      <button type="button" className="tile-open" onClick={() => onOpen(p)} aria-label={`Open ${p.filename}`}>
        {p.thumb ? <img src={p.thumb} alt="" loading="lazy" decoding="async" width={p.width ?? undefined} height={p.height ?? undefined} /> : null}
      </button>
      {overlay?.(p)}
      {actions ? <div className="tacts">{actions(p)}</div> : null}
    </div>
  );

  if (design.grid === "justified") {
    const target = narrow ? Math.round(ROW_HEIGHT[design.size] * 0.62) : ROW_HEIGHT[design.size];
    const rows = justify(photos, width, target, gap);
    return (
      <div ref={setEl} className="jgrid" style={{ gap }}>
        {rows.map((r, i) => (
          <div key={i} className="jrow" style={{ gap, height: r.height }}>
            {r.items.map(({ item, width: w }) => tile(item, { width: w, height: r.height }))}
          </div>
        ))}
      </div>
    );
  }

  if (design.grid === "masonry") {
    const col = narrow ? Math.round(COLUMN_WIDTH[design.size] * 0.6) : COLUMN_WIDTH[design.size];
    return (
      <div ref={setEl} className="mgrid masonry" style={{ columnWidth: col, columnGap: gap, ["--gap" as string]: `${gap}px` }}>
        {photos.map((p) => tile(p, { aspectRatio: p.width && p.height ? `${p.width} / ${p.height}` : "3 / 2" }))}
      </div>
    );
  }

  const min = narrow ? Math.round(COLUMN_WIDTH[design.size] * 0.5) : Math.round(COLUMN_WIDTH[design.size] * 0.8);
  return (
    <div ref={setEl} className="mgrid square" style={{ gap, gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {photos.map((p) => tile(p))}
    </div>
  );
}
