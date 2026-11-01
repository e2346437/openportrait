import { useMemo, useState } from "react";
import { Button, Dialog, EmptyState, Field, Icon, Panel, Switch, TextInput, useToast } from "@openportrait/ui";
import { plural, type GalleryDetail, type StudioPhoto } from "../../lib/galleries.js";
import type { Patch, Reload } from "./GalleryDetail.js";

type Filter = "all" | "hidden" | "problems";

export function PhotosTab({ data, patch }: { data: GalleryDetail; patch: Patch; reload: Reload }) {
  const toast = useToast();
  const [setId, setSetId] = useState<string | "all">("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editSet, setEditSet] = useState(false);
  const { gallery: g, sets, photos } = data;
  const set = sets.find((s) => s.id === setId) ?? null;

  const countIn = (id: string) => photos.filter((p) => p.setId === id && p.state !== "missing").length;
  const shown = useMemo(
    () =>
      photos.filter((p) => {
        if (set && p.setId !== set.id) return false;
        if (filter === "hidden") return p.hidden;
        if (filter === "problems") return p.state === "missing" || p.state === "error" || p.state === "unsupported";
        return true;
      }),
    [photos, set, filter],
  );
  const problems = photos.filter((p) => p.state === "missing" || p.state === "error" || p.state === "unsupported").length;
  const hiddenCount = photos.filter((p) => p.hidden).length;
  const selecting = selected.size > 0;

  const toggle = (p: StudioPhoto) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p.id)) n.delete(p.id);
      else n.add(p.id);
      return n;
    });

  const setHidden = async (hidden: boolean) => {
    const ids = [...selected];
    if (await patch("/photos", { ids, hidden })) {
      toast(hidden ? `Hid ${plural(ids.length, "photo")} from clients` : `Showing ${plural(ids.length, "photo")} to clients`);
      setSelected(new Set());
    }
  };

  const makeCover = async (p: StudioPhoto) => {
    if (await patch("", { coverPhotoId: p.id, coverFocalX: 50, coverFocalY: 50 })) {
      toast("Cover photo changed. Fine-tune it on the Design tab.");
      setSelected(new Set());
    }
  };

  if (photos.length === 0) {
    return (
      <Panel>
        <EmptyState icon="image" title="No photos in this folder yet">
          Export JPEGs from Lightroom or Aftershoot into <span className="mono">{g.folderPath}</span>. They're picked up automatically once they finish copying.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="photos-layout">
      <nav className="sets" aria-label="Sets">
        <div className="lbl">Sets</div>
        <button type="button" className="set" aria-pressed={setId === "all"} onClick={() => setSetId("all")}>
          All photos <span className="n">{photos.filter((p) => p.state !== "missing").length}</span>
        </button>
        {sets.map((s) => (
          <button key={s.id} type="button" className="set" aria-pressed={setId === s.id} onClick={() => setSetId(s.id)}>
            {s.hidden ? <Icon name="eyeOff" /> : null}
            {s.name}
            <span className="n">{countIn(s.id)}</span>
          </button>
        ))}
      </nav>

      <div className="photos-main">
        <div className="gtools">
          {set ? (
            <Button size="sm" icon="gear" onClick={() => setEditSet(true)}>
              Set options
            </Button>
          ) : null}
          <span className="grow-sp" />
          {problems || hiddenCount ? (
            <select className="input slim" aria-label="Filter photos" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All photos</option>
              {hiddenCount ? <option value="hidden">Hidden ({hiddenCount})</option> : null}
              {problems ? <option value="problems">Needs attention ({problems})</option> : null}
            </select>
          ) : null}
        </div>

        {shown.length === 0 ? (
          <Panel>
            <EmptyState icon="image" title="Nothing matches">
              Try another filter or set.
            </EmptyState>
          </Panel>
        ) : (
          <div className={`agrid${selecting ? " selecting" : ""}`}>
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`acell ${p.state}${p.hidden ? " is-hidden" : ""}`}
                aria-pressed={selected.has(p.id)}
                aria-label={`${p.filename}${p.hidden ? ", hidden" : ""}${p.state === "missing" ? ", missing from folder" : ""}`}
                onClick={() => toggle(p)}
              >
                {p.thumb ? <img src={p.thumb} alt="" loading="lazy" decoding="async" /> : <span className="acell-ph">{p.state === "pending" ? <Icon name="refresh" /> : <Icon name="alert" />}</span>}
                {g.coverPhotoId === p.id ? <span className="tag cover">Cover</span> : p.state === "missing" ? <span className="tag miss">Missing</span> : p.state === "error" || p.state === "unsupported" ? <span className="tag miss">Can't read</span> : p.hidden ? <span className="tag">Hidden</span> : null}
                <span className="sel">{selected.has(p.id) ? <Icon name="check" width={14} height={14} /> : null}</span>
                <span className="fname">{p.filename}</span>
              </button>
            ))}
          </div>
        )}

        {selecting ? (
          <div className="bulk" role="region" aria-label="Selected photos">
            <span className="n">{selected.size} selected</span>
            {selected.size === 1 ? (
              <Button size="sm" onClick={() => makeCover(photos.find((p) => p.id === [...selected][0])!)}>
                Use as cover
              </Button>
            ) : null}
            <Button size="sm" icon="eyeOff" onClick={() => setHidden(true)}>
              Hide
            </Button>
            <Button size="sm" icon="eye" onClick={() => setHidden(false)}>
              Show
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        ) : (
          <p className="hint pick-hint">Select photos to hide them or choose a cover. Photos always come from the folder, so rename or reorder files there.</p>
        )}
      </div>

      {set ? <SetOptions key={set.id} open={editSet} onClose={() => setEditSet(false)} data={data} setId={set.id} patch={patch} /> : null}
    </div>
  );
}

function SetOptions({ open, onClose, data, setId, patch }: { open: boolean; onClose: () => void; data: GalleryDetail; setId: string; patch: Patch }) {
  const s = data.sets.find((x) => x.id === setId)!;
  const [name, setName] = useState(s.name);
  const save = (body: object) => patch(`/sets/${s.id}`, body);
  return (
    <Dialog open={open} onClose={onClose} title="Set options" description={s.folderName ? `Folder: ${s.folderName}` : "Photos directly in the gallery folder"}>
      <Field label="Name shown to clients">
        {(p) => (
          <TextInput
            {...p}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== s.name && save({ name: name.trim() })}
          />
        )}
      </Field>
      <div className="toggle-row">
        <div>
          <b>Hide this set</b>
          <span>Clients won't see it or its photos.</span>
        </div>
        <Switch label="Hide this set" checked={s.hidden} onChange={(v) => save({ hidden: v })} />
      </div>
      {data.gallery.downloadLock === "highlights_early" ? (
        <div className="toggle-row">
          <div>
            <b>Allow download before payment</b>
            <span>Use for Highlights. Everything else opens after payment.</span>
          </div>
          <Switch label="Allow download before payment" checked={s.earlyDownload} onChange={(v) => save({ earlyDownload: v })} />
        </div>
      ) : null}
    </Dialog>
  );
}
