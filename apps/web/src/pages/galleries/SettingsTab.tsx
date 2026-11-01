import { useState } from "react";
import { Button, Callout, CopyValue, Dialog, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { LOCK_LABELS, formatDate, type DownloadLock, type DownloadSize, type GalleryDetail } from "../../lib/galleries.js";
import type { Patch } from "./GalleryDetail.js";

const SIZES: Array<{ id: DownloadSize; title: string; body: string }> = [
  { id: "full", title: "Full size", body: "The files exactly as you exported them." },
  { id: "web", title: "Web size", body: "2048 px JPEGs, small enough to post and share." },
  { id: "none", title: "No downloads", body: "Clients can view and favorite only." },
];

const dateInput = (ms: number | null) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : "");

export function SettingsTab({ data, patch, onDeleted }: { data: GalleryDetail; patch: Patch; onDeleted: () => void }) {
  const g = data.gallery;
  const toast = useToast();
  const [title, setTitle] = useState(g.title);
  const [slug, setSlug] = useState(g.slug);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const dirty = title.trim() !== g.title || slug.trim() !== g.slug;

  const saveBasics = async () => {
    setSaving(true);
    setErrors({});
    try {
      await api(`/galleries/${g.id}`, { method: "PATCH", body: { title: title.trim(), slug: slug.trim() } });
      await patch("", {}); // reload the gallery with the new name and link
      toast("Saved");
    } catch (e) {
      const err = e as { field?: string; message: string };
      setErrors({ [err.field ?? "title"]: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab">
      <Panel
        title="Name and link"
        footer={
          <div className="form-actions">
            <Button variant="primary" loading={saving} disabled={!dirty || !title.trim()} onClick={saveBasics}>
              Save changes
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Field label="Title" error={errors.title}>
            {(p) => <TextInput {...p} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label="Link ending" error={errors.slug} hint="Anyone with the link can view. Changing it breaks links already sent.">
            {(p) => <TextInput {...p} value={slug} maxLength={80} onChange={(e) => setSlug(e.target.value.toLowerCase())} />}
          </Field>
        </div>
        <CopyValue value={g.url} label="gallery link" />
      </Panel>

      <Panel title="Downloads" description="What clients can download, and when.">
        <fieldset className="opts">
          <legend className="label">Size</legend>
          {SIZES.map((s) => (
            <label key={s.id} className="opt">
              <input type="radio" name="size" checked={g.downloadSize === s.id} onChange={() => patch("", { downloadSize: s.id })} />
              <span className="t">
                <b>{s.title}</b>
                <span>{s.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="opts">
          <legend className="label">When</legend>
          {(Object.keys(LOCK_LABELS) as DownloadLock[]).map((k) => (
            <label key={k} className="opt">
              <input type="radio" name="lock" checked={g.downloadLock === k} onChange={() => patch("", { downloadLock: k })} />
              <span className="t">
                <b>{LOCK_LABELS[k].title}</b>
                <span>{LOCK_LABELS[k].body}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {g.downloadLock !== "none" ? (
          <Callout tone={g.unlockedAt ? "ok" : "warn"} title={g.unlockedAt ? `Unlocked ${formatDate(g.unlockedAt)}` : "Still locked"} action={<Button size="sm" onClick={() => patch("/unlock", { locked: !!g.unlockedAt }, "POST")}>{g.unlockedAt ? "Lock again" : "Mark as paid"}</Button>}>
            {g.unlockedAt ? "Clients can download everything." : "Mark the gallery paid by hand for cash or check payments. Online payment will do this automatically."}
          </Callout>
        ) : null}
      </Panel>

      <Panel title="Expiry" description="After this date the link stops working. Your photos stay on the share.">
        <Field label="Expires on" hint="Leave empty to keep the gallery online.">
          {(p) => <input {...p} type="date" className="input date" value={dateInput(g.expiresAt)} onChange={(e) => patch("", { expiresAt: e.target.value ? new Date(`${e.target.value}T23:59:59`).getTime() : null })} />}
        </Field>
      </Panel>

      <Panel title="Folder">
        <dl className="kv">
          <dt>Shoot folder</dt>
          <dd className="mono">{g.shootFolder}</dd>
          <dt>Photos read from</dt>
          <dd className="mono">{g.folderPath}</dd>
        </dl>
        <div>
          <Button
            icon="refresh"
            onClick={async () => {
              const r = await api<{ result: { added: number; changed: number; missing: number } }>(`/galleries/${g.id}/rescan`, { method: "POST", body: {} }).catch((e: Error) => toast(e.message, "bad"));
              if (r) {
                toast(r.result.added + r.result.changed + r.result.missing === 0 ? "Everything is up to date" : `${r.result.added} new, ${r.result.changed} updated, ${r.result.missing} missing`);
                await patch("", {});
              }
            }}
          >
            Check this folder now
          </Button>
        </div>
      </Panel>

      <Panel title="Remove gallery">
        <p className="muted">Removes the gallery, its link, and clients' favorites from OpenPortrait. Your photos on the share are not touched, and the folder will come back as a new folder to review.</p>
        <div>
          <Button variant="danger" icon="trash" onClick={() => setRemoving(true)}>
            Remove gallery…
          </Button>
        </div>
      </Panel>

      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove “${g.title}”?`}
        description="The link stops working immediately. This can't be undone, but your photos stay on the share."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              className="danger-solid"
              onClick={async () => {
                try {
                  await api(`/galleries/${g.id}`, { method: "DELETE" });
                  toast("Gallery removed");
                  onDeleted();
                } catch (e) {
                  toast((e as Error).message, "bad");
                }
              }}
            >
              Remove gallery
            </Button>
          </>
        }
      />
    </div>
  );
}
