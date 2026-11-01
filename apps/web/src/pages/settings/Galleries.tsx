import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { LOCK_LABELS, type DownloadLock } from "../../lib/galleries.js";

interface GallerySettings {
  deliveryFolder: string;
  privateFolders: string[];
  defaultDownloadLock: DownloadLock;
}

export function GallerySettingsPage() {
  const { me } = useSession();
  const toast = useToast();
  const owner = me?.user?.role === "owner";
  const [saved, setSaved] = useState<GallerySettings | null>(null);
  const [form, setForm] = useState<GallerySettings | null>(null);
  const [priv, setPriv] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<GallerySettings>("/ingest/settings")
      .then((s) => {
        setSaved(s);
        setForm(s);
        setPriv(s.privateFolders.join(", "));
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const body = form && { ...form, privateFolders: priv.split(",").map((x) => x.trim()).filter(Boolean) };
  const dirty = !!saved && !!body && JSON.stringify(body) !== JSON.stringify(saved);
  const { busy, error, fieldErrors, submit } = useSubmit(() => api<GallerySettings>("/ingest/settings", { method: "PUT", body }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit();
    if (!r) return;
    setSaved(r);
    setForm(r);
    toast("Gallery settings saved");
  };

  if (loadError) return <Callout tone="bad" title="Couldn't load gallery settings">{loadError}</Callout>;
  if (!form) return <div className="skeleton" style={{ height: 240 }} aria-busy="true" />;

  return (
    <form onSubmit={onSubmit} noValidate className="stack">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <Panel
        title="Download lock"
        description="The choice the share dialog starts on for each new gallery. You can still pick differently for each gallery when you share it."
      >
        <fieldset className="opts" disabled={!owner}>
          <legend className="sr-only">Default download lock</legend>
          {(Object.keys(LOCK_LABELS) as DownloadLock[]).map((k) => (
            <label key={k} className="opt">
              <input type="radio" name="lock" checked={form.defaultDownloadLock === k} onChange={() => setForm({ ...form, defaultDownloadLock: k })} />
              <span className="t">
                <b>{LOCK_LABELS[k].title}</b>
                <span>{LOCK_LABELS[k].body}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Panel>
      <Panel
        title="Folders"
        description="How OpenPortrait reads each shoot folder on the gallery share."
        footer={
          owner ? (
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
                Save changes
              </Button>
            </div>
          ) : (
            <span className="hint">Only the studio owner can change these.</span>
          )
        }
      >
        <div className="form-grid">
          <Field label="Delivery folder" error={fieldErrors.deliveryFolder} hint="The folder inside each shoot that becomes the client gallery. Its subfolders become sets.">
            {(p) => <TextInput {...p} className="input mono" disabled={!owner} value={form.deliveryFolder} onChange={(e) => setForm({ ...form, deliveryFolder: e.target.value })} />}
          </Field>
          <Field label="Folders to never read" error={fieldErrors.privateFolders} hint="Separate with commas. Camera originals and RAW files stay private.">
            {(p) => <TextInput {...p} className="input mono" disabled={!owner} value={priv} onChange={(e) => setPriv(e.target.value)} />}
          </Field>
        </div>
      </Panel>
    </form>
  );
}
