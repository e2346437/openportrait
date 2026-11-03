import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout, Field, Panel, Spinner, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { SwitchRow } from "../../components/SwitchRow.js";

type Mode = "text" | "logo" | "image";
type Position = "tile" | "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";
interface Spec {
  mode: Mode;
  font: string;
  style: "regular" | "bold" | "italic";
  color: string;
  textSize: number;
  size: number;
  opacity: number;
  position: Position;
}
interface State {
  spec: Spec;
  text: string;
  hasLogo: boolean;
  image: string | null;
  fonts: Array<{ id: string; label: string }>;
}

const GRID: Position[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
const GRID_LABEL: Record<string, string> = { "top-left": "Top left", top: "Top", "top-right": "Top right", left: "Left", center: "Center", right: "Right", "bottom-left": "Bottom left", bottom: "Bottom", "bottom-right": "Bottom right" };
const SWATCHES = [
  { label: "White", value: "#ffffff" },
  { label: "Black", value: "#000000" },
  { label: "Lens", value: "#c2461f" },
];

/** What previews carry while their gallery is locked until payment: wording, the studio logo, or a custom image. */
export function WatermarkPanel({ owner }: { owner: boolean }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<State | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [lastCorner, setLastCorner] = useState<Position>("bottom-right");
  const [previewKey, setPreviewKey] = useState("");
  const [previewState, setPreviewState] = useState<"loading" | "ok" | "error">("loading");

  const apply = (s: State) => {
    setSaved(s);
    setSpec(s.spec);
    setText(s.text);
    if (s.spec.position !== "tile") setLastCorner(s.spec.position);
  };
  useEffect(() => {
    api<State>("/watermark").then(apply).catch((e: Error) => setLoadError(e.message));
  }, []);

  // The preview is drawn by the server with the same code that marks real photos. Wait a moment after each change.
  const query = useMemo(() => {
    if (!spec) return "";
    const p = new URLSearchParams({ mode: spec.mode, font: spec.font, style: spec.style, color: spec.color, textSize: String(spec.textSize), size: String(spec.size), opacity: String(spec.opacity), position: spec.position, text });
    return p.toString();
  }, [spec, text]);
  useEffect(() => {
    if (!query) return;
    setPreviewState("loading");
    const t = setTimeout(() => setPreviewKey(`${query}&v=${saved?.image ?? ""}`), 250);
    return () => clearTimeout(t);
  }, [query, saved?.image]);

  const dirty = !!saved && !!spec && (JSON.stringify(spec) !== JSON.stringify(saved.spec) || text !== saved.text);
  const save = useSubmit(() => api<State>("/watermark", { method: "PUT", body: { spec, text } }));

  if (loadError) return <Callout tone="bad" title="Couldn't load the watermark settings">{loadError}</Callout>;
  if (!saved || !spec) return <div className="skeleton" style={{ height: 320 }} aria-busy="true" />;

  const set = <K extends keyof Spec>(k: K, v: Spec[K]) => setSpec({ ...spec, [k]: v });
  const missing = (spec.mode === "logo" && !saved.hasLogo) || (spec.mode === "image" && !saved.image);

  const onSave = async () => {
    const r = await save.submit();
    if (!r) return;
    apply(r);
    toast("Watermark saved");
  };
  const upload = async (f: File) => {
    setUploading(true);
    try {
      const res = await fetch("/api/studio/watermark/image", { method: "PUT", credentials: "same-origin", headers: { "content-type": f.type }, body: f });
      const data = (await res.json().catch(() => ({}))) as State & { message?: string };
      if (!res.ok) throw new Error(data.message ?? "That file couldn't be used. Try a PNG, JPEG or WebP image under 5 MB.");
      setSaved((s) => (s ? { ...s, image: data.image } : s));
      toast("Image uploaded");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  };
  const removeImage = async () => {
    const r = await api<State>("/watermark/image", { method: "DELETE" });
    setSaved((s) => (s ? { ...s, image: r.image } : s));
    toast("Image removed");
  };

  const modes: Array<{ id: Mode; title: string; body: string }> = [
    { id: "text", title: "Text", body: "Your studio name, or wording you choose." },
    { id: "logo", title: "Studio logo", body: saved.hasLogo ? "Uses the logo uploaded above." : "Upload a logo above first." },
    { id: "image", title: "Custom image", body: "A PNG, WebP or JPEG. Transparent PNG works best." },
  ];

  return (
    <Panel
      title="Watermark"
      description="Previews of photos still locked until payment carry this mark. It disappears once the gallery is paid for, and downloaded files never have it."
      footer={
        owner ? (
          <div className="form-actions">
            {dirty ? (
              <Button variant="ghost" onClick={() => { setSpec(saved.spec); setText(saved.text); }}>
                Discard changes
              </Button>
            ) : null}
            <Button variant="primary" loading={save.busy} disabled={!dirty} onClick={onSave}>
              Save watermark
            </Button>
          </div>
        ) : (
          <span className="hint">Only the studio owner can change this.</span>
        )
      }
    >
      {save.error ? <Callout tone="bad">{save.error}</Callout> : null}
      <div className="wm-layout">
        <div className="wm-controls">
          <fieldset className="opts" disabled={!owner}>
            <legend className="sr-only">Watermark type</legend>
            {modes.map((m) => (
              <label key={m.id} className="opt">
                <input type="radio" name="wm-mode" checked={spec.mode === m.id} onChange={() => set("mode", m.id)} />
                <span className="t">
                  <b>{m.title}</b>
                  <span>{m.body}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {spec.mode === "text" ? (
            <div className="form-grid tight">
              <Field className="span-2" label="Wording" hint="Leave empty to use your studio name.">
                {(p) => <TextInput {...p} disabled={!owner} maxLength={60} value={text} placeholder="Your studio name" onChange={(e) => setText(e.target.value)} />}
              </Field>
              <Field label="Font">
                {(p) => (
                  <select {...p} className="input" disabled={!owner} value={spec.font} onChange={(e) => set("font", e.target.value)}>
                    {saved.fonts.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Style">
                {(p) => (
                  <select {...p} className="input" disabled={!owner} value={spec.style} onChange={(e) => set("style", e.target.value as Spec["style"])}>
                    <option value="regular">Regular</option>
                    <option value="bold">Bold</option>
                    <option value="italic">Italic</option>
                  </select>
                )}
              </Field>
              <Field label={`Text size: ${spec.textSize}`} hint="Relative to the photo, so it looks the same at every size.">
                {(p) => <input {...p} type="range" className="range" min={20} max={200} step={2} disabled={!owner} value={spec.textSize} onChange={(e) => set("textSize", Number(e.target.value))} />}
              </Field>
              <Field label="Color">
                {(p) => (
                  <div className="color-row">
                    <input {...p} type="color" className="color-input" disabled={!owner} value={spec.color} onChange={(e) => set("color", e.target.value)} />
                    {SWATCHES.map((s) => (
                      <button key={s.value} type="button" className="btn sm" disabled={!owner} aria-pressed={spec.color.toLowerCase() === s.value} onClick={() => set("color", s.value)}>
                        <span className="swatch" style={{ background: s.value }} aria-hidden="true" />
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </div>
          ) : null}

          {spec.mode === "image" ? (
            <div className="wm-image">
              <div className="wm-thumb">{saved.image ? <img src={saved.image} alt="Custom watermark image" /> : <span className="muted">No image yet</span>}</div>
              {owner ? (
                <div className="logo-acts">
                  <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                  <Button icon="plus" loading={uploading} onClick={() => file.current?.click()}>
                    {saved.image ? "Replace image" : "Upload image"}
                  </Button>
                  {saved.image ? (
                    <Button variant="ghost" onClick={removeImage}>
                      Remove
                    </Button>
                  ) : null}
                  <span className="hint">Up to 5 MB. It is resized to fit every preview automatically.</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {spec.mode !== "text" ? (
            <Field label={`Size: ${spec.size}% of the photo's width`}>
              {(p) => <input {...p} type="range" className="range" min={8} max={80} disabled={!owner} value={spec.size} onChange={(e) => set("size", Number(e.target.value))} />}
            </Field>
          ) : null}
          {missing ? <Callout tone="warn">{spec.mode === "logo" ? "No studio logo is uploaded yet, so your wording is shown instead." : "Upload an image to use it. Until then your wording is shown."}</Callout> : null}

          <Field label={`Opacity: ${spec.opacity}%`}>
            {(p) => <input {...p} type="range" className="range" min={10} max={100} step={5} disabled={!owner} value={spec.opacity} onChange={(e) => set("opacity", Number(e.target.value))} />}
          </Field>

          <div className="field">
            <span className="label" id="wm-pos">Position</span>
            <div className="pos-row">
              <div className="pos-grid" role="group" aria-labelledby="wm-pos">
                {GRID.map((g) => (
                  <button key={g} type="button" className="pos-cell" aria-label={GRID_LABEL[g]} aria-pressed={spec.position === g} disabled={!owner || spec.position === "tile"} onClick={() => { setLastCorner(g); set("position", g); }} />
                ))}
              </div>
              <SwitchRow checked={spec.position === "tile"} onChange={(v) => owner && set("position", v ? "tile" : lastCorner)} label="Repeat across the photo" hint="Harder to crop out." />
            </div>
          </div>
        </div>

        <div className="wm-preview">
          <b>Preview</b>
          <div className="wm-photo" aria-busy={previewState === "loading"}>
            {previewKey ? <img src={`/api/studio/watermark/preview?${previewKey}`} alt="A sample photo with the watermark on it" onLoad={() => setPreviewState("ok")} onError={() => setPreviewState("error")} /> : null}
            {previewState === "loading" ? <span className="wm-busy"><Spinner label="Updating preview" /></span> : null}
            {previewState === "error" ? <span className="wm-busy hint">Preview unavailable</span> : null}
          </div>
          <span className="hint">A sample photo, drawn the same way real previews are.</span>
        </div>
      </div>
    </Panel>
  );
}
