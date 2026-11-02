import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Icon, PageHeader, Panel, Segmented, Spinner, StatusChip, Switch, Tabs, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";
import { blankBlock, BLOCK_LABELS, PAGE_IDS, PAGE_LABELS, photoIdsOf, type Block, type BlockType, type OptionField, type PageId, type SiteConfig, type SiteReport, type SiteState } from "../../lib/site.js";
import { BlockCard, PhotoField } from "./BlockEditor.js";
import { useThumbs } from "./useThumbs.js";
import "./website.css";

type Tab = "look" | "pages" | "details" | "more";
type Save = "idle" | "saving" | "saved" | "error";

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="wb-color">
        <input type="color" aria-label={`${label} picker`} value={value} onChange={(e) => onChange(e.target.value)} />
        <TextInput aria-label={`${label} hex value`} value={value} maxLength={7} spellCheck={false} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && onChange(e.target.value)} />
      </div>
    </div>
  );
}

function OptionControl({ f, value, onChange }: { f: OptionField; value: unknown; onChange: (v: unknown) => void }) {
  if (f.type === "toggle")
    return (
      <div className="wb-toggle-row">
        <div><b>{f.label}</b>{f.hint ? <span className="hint">{f.hint}</span> : null}</div>
        <Switch label={f.label} checked={value === true} onChange={onChange} />
      </div>
    );
  if (f.type === "list") {
    const rows = Array.isArray(value) ? (value as Array<Record<string, string>>) : [];
    const cols = f.columns ?? [];
    return (
      <div className="field">
        <label>{f.label}</label>
        {f.hint ? <span className="hint">{f.hint}</span> : null}
        {rows.map((r, i) => (
          <div className="wb-item" key={i}>
            {cols.map((c) =>
              c.type === "textarea" ? (
                <TextArea key={c.key} aria-label={`${c.label} ${i + 1}`} placeholder={c.label} rows={5} value={r[c.key] ?? ""} onChange={(e) => onChange(rows.map((x, k) => (k === i ? { ...x, [c.key]: e.target.value } : x)))} />
              ) : (
                <TextInput key={c.key} aria-label={`${c.label} ${i + 1}`} placeholder={c.label} type={c.type === "date" ? "date" : "text"} value={r[c.key] ?? ""} onChange={(e) => onChange(rows.map((x, k) => (k === i ? { ...x, [c.key]: e.target.value } : x)))} />
              ),
            )}
            <div><Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, k) => k !== i))}>Remove</Button></div>
          </div>
        ))}
        <div><Button size="sm" icon="plus" onClick={() => onChange([...rows, Object.fromEntries(cols.map((c) => [c.key, ""]))])}>Add</Button></div>
      </div>
    );
  }
  return <Field label={f.label} hint={f.hint}>{(p) => (f.type === "textarea" ? <TextArea {...p} rows={6} placeholder={f.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} /> : <TextInput {...p} placeholder={f.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />)}</Field>;
}

function PublishDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const report = useLoad<SiteReport>(open ? "/site/report" : null);
  const r = report.data;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Publish your website"
      description="OpenPortrait makes a plain static website: ordinary files you can upload to any web host. There is no database and nothing to keep patched."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <a className={`btn primary${report.loading || !r ? " disabled" : ""}`} href="/api/studio/site/export.zip" download aria-disabled={report.loading || !r}>
            <Icon name="download" />Download website (.zip)
          </a>
        </>
      }
    >
      {report.loading && !r ? (
        <div className="detail-loading"><Spinner label="Preparing your site" /></div>
      ) : report.error ? (
        <Callout tone="bad">{report.error}</Callout>
      ) : r ? (
        <div className="wb-publish">
          <p className="muted">{r.pages} pages, {r.photos} photos, {(r.bytes / 1_048_576).toFixed(1)} MB. Only the photos you picked are included, as web-size copies with camera data removed.</p>
          {r.warnings.length ? (
            <Callout tone="warn" title="Worth a look before you publish">
              <ul className="wb-warns">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </Callout>
          ) : (
            <Callout tone="ok">Nothing to fix. Your site is ready to upload.</Callout>
          )}
          <h3>Put it online with Cloudflare Pages (recommended)</h3>
          <ol className="wb-steps">
            <li>Download the website and unzip it.</li>
            <li>In Cloudflare, open <b>Workers &amp; Pages</b>, choose <b>Create</b>, then <b>Pages</b> and <b>Upload assets</b>.</li>
            <li>Name the project and drag in the unzipped folder, then deploy.</li>
            <li>Add your own domain under the project's <b>Custom domains</b>.</li>
          </ol>
          <p className="hint">It's free for a site like this and serves from Cloudflare's network. To update the site later, change it here, download again and upload a new deployment. Any other static host works the same way. See the <a href="https://github.com/e2346437/openportrait/blob/main/docs/website.md" target="_blank" rel="noreferrer">website guide</a> for details.</p>
        </div>
      ) : null}
    </Dialog>
  );
}

export function WebsitePage() {
  const toast = useToast();
  const state = useLoad<SiteState>("/site");
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [tab, setTab] = useState<Tab>("look");
  const [pageId, setPageId] = useState<PageId>("home");
  const [save, setSave] = useState<Save>("idle");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [publish, setPublish] = useState(false);
  const [addType, setAddType] = useState<BlockType>("text");
  const frame = useRef<HTMLIFrameElement>(null);
  const dirty = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    if (state.data && !config) setConfig(state.data.config);
  }, [state.data, config]);

  const thumbs = useThumbs(config ? photoIdsOf(config) : []);

  // Save a moment after the last edit, then refresh the preview.
  useEffect(() => {
    if (!config || !dirty.current) return;
    setSave("saving");
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        await api("/site", { method: "PUT", body: config });
        if (mine !== seq.current) return;
        dirty.current = false;
        setSave("saved");
        frame.current?.contentWindow?.location.reload();
      } catch (e) {
        if (mine === seq.current) {
          setSave("error");
          toast((e as Error).message, "bad");
        }
      }
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const update = useCallback((fn: (draft: SiteConfig) => void) => {
    setConfig((cur) => {
      if (!cur) return cur;
      const next = structuredClone(cur);
      fn(next);
      dirty.current = true;
      return next;
    });
  }, []);

  const info = state.data;
  const template = useMemo(() => info?.templates.find((t) => t.id === config?.template), [info, config?.template]);

  if (state.error && !info) return <Callout tone="bad">{state.error}</Callout>;
  if (!info || !config) return <div className="detail-loading"><Spinner label="Loading your website" /></div>;

  const inquireReady = !!info.publicUrl && !/localhost|^http:\/\/(\d|192|10\.)/.test(info.publicUrl);
  const page = config.pages[pageId];
  const ctx = { config, thumbs, inquireReady, update };
  const photoCount = photoIdsOf(config).length;

  const chooseTemplate = (id: string) => {
    const t = info.templates.find((x) => x.id === id);
    if (!t || id === config.template) return;
    update((d) => {
      d.template = id;
      d.theme = { ...t.theme };
    });
  };

  const setBlock = (i: number, b: Block) => update((d) => void (d.pages[pageId].blocks[i] = b));
  const moveBlock = (i: number, dir: -1 | 1) =>
    update((d) => {
      const arr = d.pages[pageId].blocks;
      const j = i + dir;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    });

  const reset = async () => {
    if (!window.confirm("Start over with a fresh default site? Your pages, colors and photo choices will be replaced.")) return;
    const fresh = await api<SiteState>("/site/reset", { method: "POST", body: {} });
    dirty.current = false;
    setConfig(fresh.config);
    setSave("idle");
    frame.current?.contentWindow?.location.reload();
  };

  const saveLabel = save === "saving" ? "Saving…" : save === "saved" ? "All changes saved" : save === "error" ? "Couldn't save" : info.saved ? "Saved" : "Not published yet";

  return (
    <div className="wb">
      <PageHeader
        title="Website"
        description="Build your studio's website from your own photos. It exports as plain files you can host anywhere."
        actions={
          <>
            <span className="wb-save" role="status"><StatusChip tone={save === "error" ? "bad" : save === "saving" ? "info" : "neutral"}>{saveLabel}</StatusChip></span>
            <a className="btn" href="/api/studio/site/preview/" target="_blank" rel="noreferrer"><Icon name="external" />Open preview</a>
            <Button variant="primary" icon="globe" onClick={() => setPublish(true)}>Publish</Button>
          </>
        }
      />
      <div className="wb-mobile-toggle">
        <Segmented label="Show" value={view} onChange={setView} options={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
      </div>
      <div className="wb-layout" data-view={view}>
        <div className="wb-editor">
          <Tabs<Tab> label="Website sections" value={tab} onChange={setTab} tabs={[{ id: "look", label: "Look", icon: "palette" }, { id: "pages", label: "Pages", icon: "grid" }, { id: "details", label: "Details", icon: "note" }, ...(info.options.length ? [{ id: "more" as Tab, label: "More", icon: "sparkle" as const }] : [])]} />

          {tab === "look" ? (
            <div className="stack">
              <Panel title="Template" description="Pick a starting look. Everything below can still be changed.">
                <div className="wb-templates" role="radiogroup" aria-label="Template">
                  {info.templates.map((t) => (
                    <button key={t.id} type="button" role="radio" aria-checked={t.id === config.template} className="wb-tpl" onClick={() => chooseTemplate(t.id)}>
                      <span className="wb-tpl-swatch" style={{ background: t.theme.bg, color: t.theme.text }} aria-hidden>
                        <i style={{ background: t.theme.accent }} />
                        <b style={{ fontFamily: info.fonts.find((f) => f.id === t.theme.headingFont)?.stack }}>Aa</b>
                      </span>
                      <span className="wb-tpl-name">{t.name}{t.extra ? <em>Pro</em> : null}</span>
                      <span className="wb-tpl-desc">{t.description}</span>
                    </button>
                  ))}
                </div>
                {template ? null : <Callout tone="warn">The template "{config.template}" isn't available right now, so the site is using the first one. It comes back if you turn its extension back on.</Callout>}
              </Panel>
              <Panel title="Colors">
                <div className="wb-colors">
                  <ColorField label="Background" value={config.theme.bg} onChange={(v) => update((d) => void (d.theme.bg = v))} />
                  <ColorField label="Text" value={config.theme.text} onChange={(v) => update((d) => void (d.theme.text = v))} />
                  <ColorField label="Soft text" value={config.theme.muted} onChange={(v) => update((d) => void (d.theme.muted = v))} />
                  <ColorField label="Accent (links and buttons)" value={config.theme.accent} onChange={(v) => update((d) => void (d.theme.accent = v))} />
                </div>
              </Panel>
              <Panel title="Type and shape" description="Fonts are built into your site, so visitors never load anything from a font service.">
                <div className="wb-two">
                  <Field label="Headings font">{(p) => <select {...p} className="input" value={config.theme.headingFont} onChange={(e) => update((d) => void (d.theme.headingFont = e.target.value))}>{info.fonts.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>}</Field>
                  <Field label="Body font">{(p) => <select {...p} className="input" value={config.theme.bodyFont} onChange={(e) => update((d) => void (d.theme.bodyFont = e.target.value))}>{info.fonts.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>}</Field>
                </div>
                <Field label="Heading size">{() => <Segmented label="Heading size" value={config.theme.headingSize} onChange={(v) => update((d) => void (d.theme.headingSize = v))} options={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }]} />}</Field>
                <Field label="Corners">{() => <Segmented label="Corners" value={config.theme.corners} onChange={(v) => update((d) => void (d.theme.corners = v))} options={[{ value: "square", label: "Square" }, { value: "soft", label: "Soft" }, { value: "round", label: "Round" }]} />}</Field>
              </Panel>
              <Panel title="Logo">
                <div className="wb-toggle-row">
                  <div><b>Show my logo instead of my name</b><span className="hint">{info.hasLogo ? "Uses the logo from Settings, Galleries." : "Upload a logo in Settings, Galleries first."}</span></div>
                  <Switch label="Show my logo" checked={config.useLogo && info.hasLogo} disabled={!info.hasLogo} onChange={(v) => update((d) => void (d.useLogo = v))} />
                </div>
              </Panel>
              <div><Button variant="ghost" onClick={reset}>Start over with the default site</Button></div>
            </div>
          ) : null}

          {tab === "pages" ? (
            <div className="stack">
              <Panel title="Pages" description="Turn pages on or off and choose which one to edit.">
                <ul className="wb-pages">
                  {PAGE_IDS.map((id) => (
                    <li key={id} data-active={id === pageId}>
                      <button type="button" className="wb-page-pick" aria-pressed={id === pageId} onClick={() => setPageId(id)}>
                        <b>{config.pages[id].nav || PAGE_LABELS[id]}</b>
                        <small>{config.pages[id].enabled ? `${config.pages[id].blocks.length} section${config.pages[id].blocks.length === 1 ? "" : "s"}` : "Off"}</small>
                      </button>
                      <Switch label={`Show the ${PAGE_LABELS[id]} page`} checked={config.pages[id].enabled} onChange={(v) => update((d) => void (d.pages[id].enabled = v))} />
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title={`${PAGE_LABELS[pageId]} page`} description={page.enabled ? undefined : "This page is switched off, so it isn't in your menu or your export."}>
                <div className="wb-two">
                  <Field label="Menu label">{(p) => <TextInput {...p} value={page.nav} onChange={(e) => update((d) => void (d.pages[pageId].nav = e.target.value))} />}</Field>
                  <Field label="Browser tab title">{(p) => <TextInput {...p} value={page.title} onChange={(e) => update((d) => void (d.pages[pageId].title = e.target.value))} />}</Field>
                </div>
                <Field label="Search description" hint="One or two sentences shown under your page in search results.">{(p) => <TextArea {...p} rows={2} value={page.description} onChange={(e) => update((d) => void (d.pages[pageId].description = e.target.value))} />}</Field>
              </Panel>
              <Panel title="Sections" description="They appear on the page in this order.">
                {page.blocks.length ? (
                  <div className="wb-blocks">
                    {page.blocks.map((b, i) => (
                      <BlockCard key={b.id} block={b} index={i} count={page.blocks.length} ctx={ctx} onChange={(nb) => setBlock(i, nb)} onMove={(d) => moveBlock(i, d)} onRemove={() => update((d) => void d.pages[pageId].blocks.splice(i, 1))} />
                    ))}
                  </div>
                ) : (
                  <EmptyState icon="grid" title="No sections yet">Add a section below to start building this page.</EmptyState>
                )}
                <div className="wb-add">
                  <select className="input" aria-label="Section type" value={addType} onChange={(e) => setAddType(e.target.value as BlockType)}>
                    {(Object.keys(BLOCK_LABELS) as BlockType[]).map((t) => <option key={t} value={t}>{BLOCK_LABELS[t].label}: {BLOCK_LABELS[t].hint}</option>)}
                  </select>
                  <Button icon="plus" onClick={() => update((d) => void d.pages[pageId].blocks.push(blankBlock(addType)))}>Add section</Button>
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "details" ? (
            <div className="stack">
              <Panel title="Your studio">
                <div className="wb-two">
                  <Field label="Site name">{(p) => <TextInput {...p} value={config.name} onChange={(e) => update((d) => void (d.name = e.target.value))} />}</Field>
                  <Field label="Tagline">{(p) => <TextInput {...p} value={config.tagline} onChange={(e) => update((d) => void (d.tagline = e.target.value))} />}</Field>
                </div>
                <Field label="Website address" hint="Where the site will live, such as https://example.com. Optional. It's used for the sitemap and for link previews when your site is shared.">{(p) => <TextInput {...p} inputMode="url" placeholder="https://" value={config.siteUrl} onChange={(e) => update((d) => void (d.siteUrl = e.target.value))} />}</Field>
                <Field label="Footer text">{(p) => <TextInput {...p} value={config.footer.text} onChange={(e) => update((d) => void (d.footer.text = e.target.value))} />}</Field>
              </Panel>
              <Panel title="Contact" description="Shown in the contact section and the footer. Leave a line blank to hide it.">
                <div className="wb-two">
                  <Field label="Email">{(p) => <TextInput {...p} type="email" value={config.contact.email} onChange={(e) => update((d) => void (d.contact.email = e.target.value))} />}</Field>
                  <Field label="Phone">{(p) => <TextInput {...p} type="tel" value={config.contact.phone} onChange={(e) => update((d) => void (d.contact.phone = e.target.value))} />}</Field>
                </div>
                <Field label="Based in">{(p) => <TextInput {...p} value={config.contact.location} onChange={(e) => update((d) => void (d.contact.location = e.target.value))} />}</Field>
                <div className="field">
                  <label>Links</label>
                  {config.contact.links.map((l, i) => (
                    <div className="wb-item-row" key={i}>
                      <TextInput aria-label={`Link ${i + 1} label`} placeholder="Instagram" value={l.label} onChange={(e) => update((d) => void (d.contact.links[i]!.label = e.target.value))} />
                      <TextInput aria-label={`Link ${i + 1} address`} placeholder="https://" value={l.url} onChange={(e) => update((d) => void (d.contact.links[i]!.url = e.target.value))} />
                      <button type="button" className="wb-x" aria-label={`Remove link ${i + 1}`} onClick={() => update((d) => void d.contact.links.splice(i, 1))}><Icon name="x" /></button>
                    </div>
                  ))}
                  <div><Button size="sm" icon="plus" onClick={() => update((d) => void d.contact.links.push({ label: "", url: "" }))}>Add a link</Button></div>
                </div>
                <Callout tone={inquireReady ? "info" : "warn"}>{inquireReady ? "Buttons that go to your inquiry form open the form on your OpenPortrait address, so new inquiries land in Leads." : "Your inquiry form needs a public address before the website can link to it. Set one under Settings, Internet."}</Callout>
              </Panel>
              <Panel title="Search and sharing">
                <Field label="Site description" hint="Shown in search results and link previews.">{(p) => <TextArea {...p} rows={3} value={config.seo.description} onChange={(e) => update((d) => void (d.seo.description = e.target.value))} />}</Field>
                <PhotoField label="Sharing photo" id={config.seo.sharePhotoId} thumbs={thumbs} onChange={(id) => update((d) => void (d.seo.sharePhotoId = id))} hint="The picture shown when your site is shared in a message or on social media. It needs your website address above." />
              </Panel>
            </div>
          ) : null}

          {tab === "more" ? (
            <div className="stack">
              {info.options.map((group) => (
                <Panel key={group.extension} title={group.title}>
                  <div className="stack">
                    {group.fields.map((f) => (
                      <OptionControl key={f.key} f={f} value={config.extras[`${group.extension}.${f.key}`]} onChange={(v) => update((d) => void (d.extras[`${group.extension}.${f.key}`] = v))} />
                    ))}
                  </div>
                </Panel>
              ))}
            </div>
          ) : null}
        </div>

        <div className="wb-preview">
          <div className="wb-preview-bar">
            <span className="muted">Live preview{photoCount ? "" : " · no photos picked yet"}</span>
            <Segmented label="Preview size" value={device} onChange={setDevice} options={[{ value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }]} />
          </div>
          <div className="wb-frame" data-device={device}>
            <iframe ref={frame} title="Website preview" src="/api/studio/site/preview/" />
          </div>
        </div>
      </div>
      <PublishDialog open={publish} onClose={() => setPublish(false)} />
    </div>
  );
}
