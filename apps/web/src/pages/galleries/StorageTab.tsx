import { Callout, Panel, Segmented, StatusChip } from "@openportrait/ui";
import { formatBytes } from "../settings/Extensions.js";
import { plural, type FolderCounts, type GalleryDetail, type StorageChoice } from "../../lib/galleries.js";
import type { Patch } from "./GalleryDetail.js";

const CHOICES: Array<{ value: StorageChoice; label: string }> = [
  { value: "default", label: "Studio default" },
  { value: "local", label: "Keep on this server" },
  { value: "offsite", label: "Offsite" },
];

/** Where each folder's files are now, in words that match the folder names on the shoot. */
function where(c: FolderCounts): { tone: "ok" | "neutral" | "warn"; text: string } {
  if (c.local + c.remote === 0) return { tone: "neutral", text: "No files yet" };
  if (c.remote === 0) return { tone: "neutral", text: `On this server · ${plural(c.local, "file")} · ${formatBytes(c.localBytes)}` };
  if (c.local === 0) return { tone: "ok", text: `In your bucket · ${plural(c.remote, "file")} · ${formatBytes(c.remoteBytes)}` };
  return { tone: "warn", text: `Partly offsite · ${plural(c.remote, "file")} in your bucket, ${plural(c.local, "file")} still on this server` };
}

function FolderRow({ title, hint, counts, value, field, patch }: { title: string; hint: string; counts: FolderCounts; value: StorageChoice; field: "storageOriginals" | "storageGallery"; patch: Patch }) {
  const w = where(counts);
  return (
    <div className="storage-row">
      <div className="storage-row-head">
        <div>
          <h3>{title}</h3>
          <p className="hint">{hint}</p>
        </div>
        <StatusChip tone={w.tone}>{w.text}</StatusChip>
      </div>
      <Segmented label={`${title}: where to keep it`} value={value} onChange={(v) => void patch("", { [field]: v })} options={CHOICES} />
    </div>
  );
}

/** Per-gallery choice of what stays on this server and what goes to the connected storage. */
export function StorageTab({ data, patch }: { data: GalleryDetail; patch: Patch }) {
  const g = data.gallery;
  const s = data.storage;
  const stranded = !s.attached && s.originals.remote + s.gallery.remote > 0;
  return (
    <div className="settings-tab">
      {stranded ? (
        <Callout tone="warn" title="Remote storage isn't connected right now">
          Some of this gallery's files are in your bucket. They can't be downloaded until the connection is back.
        </Callout>
      ) : null}
      <Panel title="Where this gallery's files are kept" description="Choose per folder. “Studio default” follows the switches in Settings > Extensions. The gallery's previews and thumbnails always stay on this server, so it browses fast.">
        <div className="storage-rows">
          <FolderRow title="Originals folder (RAW files)" hint="Your camera files for this shoot. Never shown to clients." counts={s.originals} value={g.storageOriginals} field="storageOriginals" patch={patch} />
          <FolderRow title="Gallery folder (finished JPGs)" hint="The full-size images your clients download." counts={s.gallery} value={g.storageGallery} field="storageGallery" patch={patch} />
        </div>
      </Panel>
      <Callout tone="info">
        Changing a choice applies to files already here. Sending files offsite uploads and checks each one before it is removed from this server. Choosing “Keep on this server” brings any files back, which your storage provider may bill for.
      </Callout>
    </div>
  );
}
