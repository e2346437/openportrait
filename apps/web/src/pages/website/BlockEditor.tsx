import { useState } from "react";
import { Button, Field, Icon, Segmented, TextArea, TextInput } from "@openportrait/ui";
import { BLOCK_LABELS, type Block, type PageId, type SiteConfig } from "../../lib/site.js";
import { PhotoPicker } from "./PhotoPicker.js";
import type { Thumbs } from "./useThumbs.js";

interface Ctx {
  config: SiteConfig;
  thumbs: Thumbs;
  inquireReady: boolean;
  update: (fn: (draft: SiteConfig) => void) => void;
}

/** One photo: a thumbnail, with buttons to choose another or clear it. */
export function PhotoField({ label, id, thumbs, onChange, hint }: { label: string; id: string; thumbs: Thumbs; onChange: (id: string) => void; hint?: string }) {
  const [open, setOpen] = useState(false);
  const t = id ? thumbs.get(id) : undefined;
  return (
    <div className="field">
      <label>{label}</label>
      <div className="wb-photo-field">
        <div className="wb-thumb" aria-hidden={!t?.thumb}>{t?.thumb && !t.missing ? <img src={t.thumb} alt="" /> : <Icon name="image" />}</div>
        <div className="wb-photo-acts">
          <Button size="sm" onClick={() => setOpen(true)}>{id ? "Change photo" : "Choose photo"}</Button>
          {id ? <Button size="sm" variant="ghost" onClick={() => onChange("")}>Remove</Button> : null}
        </div>
      </div>
      {id && t?.missing ? <span className="error-text"><Icon name="alert" width={16} height={16} />This photo is no longer in your library.</span> : null}
      {hint ? <span className="hint">{hint}</span> : null}
      <PhotoPicker open={open} multiple={false} selected={id ? [id] : []} title={label} onClose={() => setOpen(false)} onDone={(ids) => { onChange(ids[0] ?? ""); setOpen(false); }} />
    </div>
  );
}

/** Photos for a gallery section, with alt text and a caption for each. */
function PhotoList({ ids, ctx, onChange }: { ids: string[]; ctx: Ctx; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const move = (i: number, d: -1 | 1) => {
    const next = [...ids];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const note = (id: string, key: "alt" | "caption", value: string) =>
    ctx.update((d) => {
      d.photos[id] = { alt: d.photos[id]?.alt ?? "", caption: d.photos[id]?.caption ?? "", [key]: value };
    });
  return (
    <div className="field">
      <label>Photos</label>
      {ids.length ? (
        <ul className="wb-plist">
          {ids.map((id, i) => {
            const t = ctx.thumbs.get(id);
            const n = ctx.config.photos[id];
            return (
              <li key={id}>
                <div className="wb-thumb">{t?.thumb && !t.missing ? <img src={t.thumb} alt="" /> : <Icon name="image" />}</div>
                <div className="wb-pfields">
                  <TextInput aria-label={`Description of photo ${i + 1} for screen readers`} placeholder="Alt text" value={n?.alt ?? ""} onChange={(e) => note(id, "alt", e.target.value)} />
                  <TextInput aria-label={`Caption for photo ${i + 1}`} placeholder="Caption (optional)" value={n?.caption ?? ""} onChange={(e) => note(id, "caption", e.target.value)} />
                  {t?.missing ? <span className="error-text"><Icon name="alert" width={16} height={16} />No longer in your library. Remove it.</span> : null}
                </div>
                <div className="wb-reorder">
                  <button type="button" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" aria-label="Move later" disabled={i === ids.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" aria-label="Remove photo" onClick={() => onChange(ids.filter((x) => x !== id))}><Icon name="x" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="wb-empty">No photos yet. Pick the ones you want to show.</div>
      )}
      <div><Button size="sm" icon="plus" onClick={() => setOpen(true)}>{ids.length ? "Add or remove photos" : "Choose photos"}</Button></div>
      <PhotoPicker open={open} multiple selected={ids} title="Choose gallery photos" onClose={() => setOpen(false)} onDone={(next) => { onChange(next); setOpen(false); }} />
    </div>
  );
}

function TargetSelect({ label, value, onChange, ctx }: { label: string; value: string; onChange: (v: string) => void; ctx: Ctx }) {
  const preset = value === "" || value === "inquire" || value.startsWith("page:");
  const [custom, setCustom] = useState(!preset);
  const selectValue = custom ? "custom" : value;
  return (
    <div className="field">
      <label>{label}</label>
      <select className="input" value={selectValue} onChange={(e) => { if (e.target.value === "custom") { setCustom(true); onChange(""); } else { setCustom(false); onChange(e.target.value); } }}>
        <option value="">No button</option>
        <option value="inquire">Your inquiry form</option>
        {(Object.keys(ctx.config.pages) as PageId[]).filter((p) => ctx.config.pages[p].enabled).map((p) => <option key={p} value={`page:${p}`}>The {ctx.config.pages[p].nav} page</option>)}
        <option value="custom">A web or mail address…</option>
      </select>
      {custom ? <TextInput aria-label={`${label} address`} placeholder="https://… or mailto:you@example.com" value={value} onChange={(e) => onChange(e.target.value)} /> : null}
      {value === "inquire" && !ctx.inquireReady ? <span className="hint">Needs your public address (Settings, Internet) so the form has a web address.</span> : null}
    </div>
  );
}

export function BlockCard({ block, index, count, ctx, onChange, onMove, onRemove }: { block: Block; index: number; count: number; ctx: Ctx; onChange: (b: Block) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const set = <K extends string>(key: K, value: unknown) => onChange({ ...block, [key]: value } as Block);
  const info = BLOCK_LABELS[block.type];
  const summary = block.heading || info.hint;
  return (
    <div className="wb-block" data-open={open}>
      <div className="wb-block-head">
        <button type="button" className="wb-block-title" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="wb-chev" aria-hidden>{open ? "▾" : "▸"}</span>
          <span><b>{info.label}</b><small>{summary}</small></span>
        </button>
        <div className="wb-reorder">
          <button type="button" aria-label={`Move ${info.label} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
          <button type="button" aria-label={`Move ${info.label} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
          <button type="button" aria-label={`Delete ${info.label}`} onClick={() => { if (window.confirm(`Delete this ${info.label.toLowerCase()} section?`)) onRemove(); }}><Icon name="trash" /></button>
        </div>
      </div>
      {open ? (
        <div className="wb-block-body">
          <Field label="Heading">{(p) => <TextInput {...p} value={block.heading} onChange={(e) => set("heading", e.target.value)} />}</Field>
          {block.type === "hero" ? (
            <>
              <Field label="Subheading">{(p) => <TextInput {...p} value={block.subheading} onChange={(e) => set("subheading", e.target.value)} />}</Field>
              <PhotoField label="Background photo" id={block.photoId} thumbs={ctx.thumbs} onChange={(id) => set("photoId", id)} hint="Pick a wide photo with space for text. Without one, the section is a plain color." />
              <Field label="Height">{() => <Segmented label="Height" value={block.height} onChange={(v) => set("height", v)} options={[{ value: "short", label: "Short" }, { value: "tall", label: "Tall" }, { value: "full", label: "Full screen" }]} />}</Field>
              <Field label="Text position">{() => <Segmented label="Text position" value={block.align} onChange={(v) => set("align", v)} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centered" }]} />}</Field>
              <Field label="Button label">{(p) => <TextInput {...p} value={block.buttonLabel} onChange={(e) => set("buttonLabel", e.target.value)} />}</Field>
              <TargetSelect label="Button goes to" value={block.buttonTarget} onChange={(v) => set("buttonTarget", v)} ctx={ctx} />
            </>
          ) : null}
          {block.type === "text" ? (
            <>
              <Field label="Text" hint="Leave a blank line between paragraphs.">{(p) => <TextArea {...p} rows={7} value={block.body} onChange={(e) => set("body", e.target.value)} />}</Field>
              <Field label="Alignment">{() => <Segmented label="Alignment" value={block.align} onChange={(v) => set("align", v)} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centered" }]} />}</Field>
            </>
          ) : null}
          {block.type === "gallery" ? (
            <>
              <PhotoList ids={block.photoIds} ctx={ctx} onChange={(ids) => set("photoIds", ids)} />
              <Field label="Layout">{() => <Segmented label="Layout" value={block.layout} onChange={(v) => set("layout", v)} options={[{ value: "auto", label: "Template default" }, { value: "masonry", label: "Masonry" }, { value: "grid", label: "Square grid" }, { value: "rows", label: "Rows" }]} />}</Field>
              {block.layout === "grid" || block.layout === "masonry" || (block.layout === "auto" && ctx.config.template !== "clean") ? <Field label="Columns">{() => <Segmented label="Columns" value={block.columns} onChange={(v) => set("columns", v)} options={[{ value: 2, label: "2" }, { value: 3, label: "3" }, { value: 4, label: "4" }]} />}</Field> : null}
            </>
          ) : null}
          {block.type === "imageText" ? (
            <>
              <Field label="Text" hint="Leave a blank line between paragraphs.">{(p) => <TextArea {...p} rows={7} value={block.body} onChange={(e) => set("body", e.target.value)} />}</Field>
              <PhotoField label="Photo" id={block.photoId} thumbs={ctx.thumbs} onChange={(id) => set("photoId", id)} />
              <Field label="Photo side">{() => <Segmented label="Photo side" value={block.side} onChange={(v) => set("side", v)} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} />}</Field>
            </>
          ) : null}
          {block.type === "services" ? (
            <>
              <Field label="Introduction">{(p) => <TextInput {...p} value={block.intro} onChange={(e) => set("intro", e.target.value)} />}</Field>
              {block.items.map((it, i) => (
                <div className="wb-item" key={i}>
                  <div className="wb-item-row">
                    <TextInput aria-label={`Service ${i + 1} name`} placeholder="Name" value={it.name} onChange={(e) => set("items", block.items.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                    <TextInput aria-label={`Service ${i + 1} price`} placeholder="Price, such as From $450" value={it.price} onChange={(e) => set("items", block.items.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))} />
                    <button type="button" className="wb-x" aria-label={`Remove service ${i + 1}`} onClick={() => set("items", block.items.filter((_, k) => k !== i))}><Icon name="x" /></button>
                  </div>
                  <TextArea aria-label={`Service ${i + 1} description`} rows={2} placeholder="What's included" value={it.description} onChange={(e) => set("items", block.items.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} />
                </div>
              ))}
              <div><Button size="sm" icon="plus" onClick={() => set("items", [...block.items, { name: "", price: "", description: "" }])}>Add a service</Button></div>
            </>
          ) : null}
          {block.type === "testimonials" ? (
            <>
              {block.items.map((it, i) => (
                <div className="wb-item" key={i}>
                  <TextArea aria-label={`Quote ${i + 1}`} rows={3} placeholder="What they said" value={it.quote} onChange={(e) => set("items", block.items.map((x, k) => (k === i ? { ...x, quote: e.target.value } : x)))} />
                  <div className="wb-item-row">
                    <TextInput aria-label={`Quote ${i + 1} author`} placeholder="Who said it" value={it.author} onChange={(e) => set("items", block.items.map((x, k) => (k === i ? { ...x, author: e.target.value } : x)))} />
                    <button type="button" className="wb-x" aria-label={`Remove quote ${i + 1}`} onClick={() => set("items", block.items.filter((_, k) => k !== i))}><Icon name="x" /></button>
                  </div>
                </div>
              ))}
              <div><Button size="sm" icon="plus" onClick={() => set("items", [...block.items, { quote: "", author: "" }])}>Add a quote</Button></div>
            </>
          ) : null}
          {block.type === "contact" ? <Field label="Introduction" hint="Your email, phone and links come from the Details tab.">{(p) => <TextInput {...p} value={block.intro} onChange={(e) => set("intro", e.target.value)} />}</Field> : null}
          {block.type === "cta" ? (
            <>
              <Field label="Text">{(p) => <TextInput {...p} value={block.body} onChange={(e) => set("body", e.target.value)} />}</Field>
              <Field label="Button label">{(p) => <TextInput {...p} value={block.buttonLabel} onChange={(e) => set("buttonLabel", e.target.value)} />}</Field>
              <TargetSelect label="Button goes to" value={block.buttonTarget} onChange={(v) => set("buttonTarget", v)} ctx={ctx} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
