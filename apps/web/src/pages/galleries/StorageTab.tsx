import { useEffect, useState } from "react";
import { Button, Callout, Dialog, Panel, Segmented, StatusChip } from "@openportrait/ui";
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

const FOLDER_WORDS = { originals: "the Originals folder (RAW files)", gallery: "the Gallery folder (finished JPGs)", both: "both folders" } as const;

/** Bring offsite files back for editing, watch them arrive, and send them back when done. */
function CheckOut({ data, patch }: { data: GalleryDetail; patch: Patch }) {
  const s = data.storage;
  const c = s.checkout;
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<"originals" | "gallery" | "both">("originals");
  const [busy, setBusy] = useState(false);
  const offsite = { originals: s.originals.remote, gallery: s.gallery.remote };
  const bytes = { originals: s.originals.remoteBytes, gallery: s.gallery.remoteBytes };
  const choices = [
    { value: "originals" as const, label: "Originals (RAW)", disabled: offsite.originals === 0 },
    { value: "gallery" as const, label: "Gallery (JPGs)", disabled: offsite.gallery === 0 },
    { value: "both" as const, label: "Both", disabled: offsite.originals === 0 || offsite.gallery === 0 },
  ].filter((o) => !o.disabled);
  const files = folders === "both" ? offsite.originals + offsite.gallery : offsite[folders];
  const size = folders === "both" ? bytes.originals + bytes.gallery : bytes[folders];

  // Files arrive in the background; keep the numbers moving while they do.
  useEffect(() => {
    if (c.state !== "preparing") return;
    const t = setInterval(() => void patch("", undefined, "GET"), 5000);
    return () => clearInterval(t);
  }, [c.state, patch]);

  const go = async (path: string, body?: unknown) => {
    setBusy(true);
    await patch(path, body ?? {}, "POST");
    setBusy(false);
  };

  if (c.state === "none") {
    if (!s.attached && files === 0) return null;
    return (
      <Panel title="Check Out" description="A client wants new crops from the RAW files? Bring this shoot's offsite files back here to edit. They return offsite on their own after 14 idle days, or when you check them in.">
        {offsite.originals + offsite.gallery === 0 ? (
          <p className="hint">Nothing from this shoot is offsite right now.</p>
        ) : (
          <div className="storage-actions"><Button variant="primary" onClick={() => { setFolders(choices[0]!.value); setOpen(true); }}>Check out files…</Button></div>
        )}
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Check out this shoot"
          description="Choose what to bring back to this server."
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={async () => { await go("/checkout", { folders }); setOpen(false); }}>Start check out</Button>
            </>
          }
        >
          <Segmented label="Folders to check out" value={folders} onChange={setFolders} options={choices} />
          <Callout tone="warn" title="This can cost real money">
            Bringing back {plural(files, "file")} ({formatBytes(size)}) means your storage provider reads and sends that data, and may charge for retrieval and transfer. Archive tiers such as Glacier can charge much more and take hours. You'll be alerted when everything is ready.
          </Callout>
        </Dialog>
      </Panel>
    );
  }

  const pct = c.totalFiles ? Math.round((c.doneFiles / c.totalFiles) * 100) : 100;
  const what = FOLDER_WORDS[c.folders ?? "both"];
  return (
    <Panel
      title="Checked out"
      actions={<StatusChip tone={c.state === "ready" ? "ok" : "warn"} pulse={c.state === "preparing"}>{c.state === "ready" ? "Ready to edit" : "Bringing files back"}</StatusChip>}
    >
      {c.state === "preparing" ? (
        <div className="ext-meter">
          <div className="ext-meter-head"><strong>Bringing back {what}</strong><span>{c.doneFiles} of {c.totalFiles} files</span></div>
          <div className="ext-meter-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Files brought back"><span style={{ width: `${pct}%` }} /></div>
          <small>You'll get an email and a task on the shoot when everything is here. You can leave this page.</small>
        </div>
      ) : (
        <p>All of {what} is on this server and ready to edit. It goes back offsite {c.returnsAt ? `on ${new Date(c.returnsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}` : `after ${c.returnDays} idle days`} unless you keep working on it, or you can send it back now.</p>
      )}
      <div className="storage-actions">
        <Button loading={busy} onClick={() => void go("/checkin")}>{c.state === "ready" ? "Check in (send back offsite)" : "Cancel check out"}</Button>
      </div>
    </Panel>
  );
}

function FolderRow({ title, hint, counts, value, locked, field, patch }: { title: string; hint: string; counts: FolderCounts; value: StorageChoice; locked: boolean; field: "storageOriginals" | "storageGallery"; patch: Patch }) {
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
      {locked ? <p className="hint">Checked out. Check in to change where this is kept.</p> : null}
      <Segmented label={`${title}: where to keep it`} disabled={locked} value={value} onChange={(v) => void patch("", { [field]: v })} options={CHOICES} />
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
      <CheckOut data={data} patch={patch} />
      <Panel title="Where this gallery's files are kept" description="Choose per folder. “Studio default” follows the switches in Settings > Extensions. The gallery's previews and thumbnails always stay on this server, so it browses fast.">
        <div className="storage-rows">
          <FolderRow title="Originals folder (RAW files)" hint="Your camera files for this shoot. Never shown to clients." counts={s.originals} value={g.storageOriginals} locked={s.checkout.state !== "none" && s.checkout.folders !== "gallery"} field="storageOriginals" patch={patch} />
          <FolderRow title="Gallery folder (finished JPGs)" hint="The full-size images your clients download." counts={s.gallery} value={g.storageGallery} locked={s.checkout.state !== "none" && s.checkout.folders !== "originals"} field="storageGallery" patch={patch} />
        </div>
      </Panel>
      <Callout tone="info">
        Changing a choice applies to files already here. Sending files offsite uploads and checks each one before it is removed from this server. Choosing “Keep on this server” brings any files back, which your storage provider may bill for.
      </Callout>
    </div>
  );
}
