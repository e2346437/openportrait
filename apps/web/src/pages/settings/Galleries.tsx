import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { LOCK_LABELS, type DownloadLock } from "../../lib/galleries.js";

interface GallerySettings {
  deliveryFolder: string;
  privateFolders: string[];
  defaultDownloadLock: DownloadLock;
  watermarkText: string;
}

/** The studio logo shown on client galleries. */
function LogoPanel({ owner }: { owner: boolean }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ logo: string | null }>("/branding")
      .then((r) => setLogo(r.logo))
      .catch(() => setLogo(null));
  }, []);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const res = await fetch("/api/studio/branding/logo", { method: "PUT", credentials: "same-origin", headers: { "content-type": file.type }, body: file });
      const data = (await res.json().catch(() => ({}))) as { logo?: string; message?: string };
      if (!res.ok) throw new Error(data.message ?? "That file couldn't be used. Try a PNG, JPEG or WebP image under 5 MB.");
      setLogo(data.logo ?? null);
      toast("Logo saved");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <Panel title="Logo" description="Shown at the top of client galleries. A PNG with a transparent background works best. Without one, your studio name is used.">
      <div className="logo-row">
        <div className="logo-preview" aria-busy={logo === undefined}>
          {logo ? <img src={logo} alt="Studio logo" /> : <span className="muted">No logo yet</span>}
        </div>
        {owner ? (
          <div className="logo-acts">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button icon="plus" loading={busy} onClick={() => input.current?.click()}>
              {logo ? "Replace logo" : "Upload logo"}
            </Button>
            {logo ? (
              <Button
                variant="ghost"
                onClick={async () => {
                  await api("/branding/logo", { method: "DELETE" });
                  setLogo(null);
                  toast("Logo removed");
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ) : (
          <span className="hint">Only the studio owner can change this.</span>
        )}
      </div>
    </Panel>
  );
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
    <div className="stack">
    <LogoPanel owner={owner} />
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
      <Panel title="Watermark" description="Previews of photos that are still locked until payment carry this wording across them. It disappears on its own once the gallery is paid for, and downloaded files never have it.">
        <Field label="Watermark wording" error={fieldErrors.watermarkText} hint="Leave empty to use your studio name.">
          {(p) => <TextInput {...p} disabled={!owner} maxLength={60} value={form.watermarkText} placeholder="Your studio name" onChange={(e) => setForm({ ...form, watermarkText: e.target.value })} />}
        </Field>
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
    </div>
  );
}
