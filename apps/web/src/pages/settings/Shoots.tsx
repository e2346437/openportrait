import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Callout, Field, Icon, Panel, StatusChip, Switch, TextInput, useToast } from "@openportrait/ui";
import { api, ApiError } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import type { FolderSettings, LeadStage, ShootType } from "../../lib/types.js";
import { useSubmit } from "../../lib/useForm.js";
import { useDebounced, useLoad } from "../../lib/useLoad.js";

export function ShootSettingsPage() {
  return (
    <div className="stack">
      <FolderPanel />
      <TypesPanel />
      <StagesPanel />
    </div>
  );
}

function useOwner() {
  const { me } = useSession();
  return me?.user?.role === "owner";
}

function FolderPanel() {
  const owner = useOwner();
  const toast = useToast();
  const { data, error, setData } = useLoad<FolderSettings>("/folders");
  const [form, setForm] = useState({ pattern: "", rawSubdir: "", deliverySubdir: "" });
  const [example, setExample] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    if (data && !loaded.current) {
      loaded.current = true;
      setForm({ pattern: data.pattern, rawSubdir: data.rawSubdir, deliverySubdir: data.deliverySubdir });
      setExample(data.example);
    }
  }, [data]);

  const draft = useDebounced(form.pattern, 250);
  useEffect(() => {
    if (!loaded.current || !draft.trim()) return;
    let live = true;
    api<{ example: string }>("/folders/preview", { body: { pattern: draft } })
      .then((r) => live && setExample(r.example))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [draft]);

  const dirty = data !== null && (form.pattern !== data.pattern || form.rawSubdir !== data.rawSubdir || form.deliverySubdir !== data.deliverySubdir);
  const { busy, error: saveError, submit } = useSubmit(() => api<FolderSettings>("/folders", { method: "PUT", body: form }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const saved = await submit();
    if (!saved) return;
    setData(saved);
    setForm({ pattern: saved.pattern, rawSubdir: saved.rawSubdir, deliverySubdir: saved.deliverySubdir });
    toast("Folder naming saved");
  };

  const insert = (token: string) => owner && setForm((f) => ({ ...f, pattern: `${f.pattern}{${token}}` }));
  const tokens = ["year", "month", "date", "type", "subject", "client", "location"];

  if (error) return <Callout tone="bad" title="Couldn't load folder settings">{error}</Callout>;

  return (
    <form onSubmit={save} noValidate>
      <Panel
        title="Shoot folders"
        description="Each shoot gets a folder on your gallery share, named from who, when and what. Export from Lightroom or Aftershoot straight into it."
        footer={
          owner ? (
            <div className="form-actions">
              {dirty ? (
                <Button variant="ghost" onClick={() => data && setForm({ pattern: data.pattern, rawSubdir: data.rawSubdir, deliverySubdir: data.deliverySubdir })}>
                  Discard changes
                </Button>
              ) : null}
              <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
                Save changes
              </Button>
            </div>
          ) : (
            <span className="hint">Only the studio owner can change this.</span>
          )
        }
      >
        {saveError ? <Callout tone="bad">{saveError}</Callout> : null}
        <Field label="Folder name pattern" hint="A slash starts a new level, so the default files shoots under their year.">
          {(p) => <TextInput {...p} className="input mono" autoComplete="off" spellCheck={false} value={form.pattern} disabled={!owner || data === null} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />}
        </Field>
        {owner ? (
          <div className="tags" aria-label="Insert a piece">
            {tokens.map((t) => (
              <button key={t} type="button" className="tag" style={{ cursor: "pointer" }} onClick={() => insert(t)} title={`Add {${t}}`}>
                <Icon name="plus" width={12} height={12} /> {t}
              </button>
            ))}
          </div>
        ) : null}
        <div className="folder-path">
          <span className="label">What it looks like</span>
          <div className="tree" aria-live="polite">
            {data ? `${data.root}/${example || "…"}/\n  ${form.rawSubdir || "…"}/\n  ${form.deliverySubdir || "…"}/` : "…"}
          </div>
          <span className="hint">Example: a headshot for Jane Smith on 14 November 2026. Characters Windows and Mac can't use are replaced, and a clash gets “(2)”.</span>
        </div>
        <div className="form-grid">
          <Field label="Camera files go in" hint="Never shown to clients.">
            {(p) => <TextInput {...p} className="input mono" autoComplete="off" spellCheck={false} value={form.rawSubdir} disabled={!owner || data === null} onChange={(e) => setForm({ ...form, rawSubdir: e.target.value })} />}
          </Field>
          <Field label="Exports go in" hint="What clients see in their gallery.">
            {(p) => <TextInput {...p} className="input mono" autoComplete="off" spellCheck={false} value={form.deliverySubdir} disabled={!owner || data === null} onChange={(e) => setForm({ ...form, deliverySubdir: e.target.value })} />}
          </Field>
        </div>
        <p className="hint">Changing the pattern only affects shoots you create from now on. Existing folders keep their names.</p>
      </Panel>
    </form>
  );
}

function TypesPanel() {
  const owner = useOwner();
  const toast = useToast();
  const { data, error, reload, setData } = useLoad<{ types: ShootType[] }>("/shoot-types");
  const [name, setName] = useState("");
  const add = useSubmit(() => api("/shoot-types", { body: { name } }));

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "bad");
      await reload();
    }
  };
  const types = data?.types ?? [];
  const reorder = (from: number, to: number) => {
    const next = [...types];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setData({ types: next });
    void run(() => api("/shoot-types-order", { method: "PUT", body: { ids: next.map((t) => t.id) } }));
  };

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (await add.submit()) {
      setName("");
      await reload();
    }
  };

  return (
    <Panel title="Shoot types" description="The kinds of work you do. Name on the left, and on the right the word that appears in folder names.">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {data === null && !error ? <div className="skeleton" style={{ height: 120 }} aria-busy="true" /> : null}
      <div>
        {types.map((t, i) => (
          <TypeRow key={t.id} type={t} owner={owner} first={i === 0} last={i === types.length - 1} onMove={(d) => reorder(i, i + d)} onChange={(patch) => run(() => api(`/shoot-types/${t.id}`, { method: "PATCH", body: patch }))} onRemove={() => run(async () => { const r = await api<{ result: string }>(`/shoot-types/${t.id}`, { method: "DELETE" }); toast(r.result === "archived" ? `“${t.name}” is archived because shoots use it` : `“${t.name}” removed`); })} />
        ))}
      </div>
      {owner ? (
        <form onSubmit={onAdd} noValidate className="input-row">
          <TextInput aria-label="New shoot type" placeholder="Add a shoot type, like “Maternity”" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" icon="plus" loading={add.busy} disabled={!name.trim()}>
            Add
          </Button>
        </form>
      ) : null}
      {add.error ? <Callout tone="bad">{add.error}</Callout> : null}
    </Panel>
  );
}

function TypeRow({ type, owner, first, last, onMove, onChange, onRemove }: { type: ShootType; owner: boolean; first: boolean; last: boolean; onMove: (delta: -1 | 1) => void; onChange: (patch: Record<string, unknown>) => void; onRemove: () => void }) {
  const [name, setName] = useState(type.name);
  const [label, setLabel] = useState(type.folderLabel);
  useEffect(() => {
    setName(type.name);
    setLabel(type.folderLabel);
  }, [type.name, type.folderLabel]);
  return (
    <div className="item-row">
      <div className="grow">
        {owner ? (
          <div className="input-row">
            <TextInput aria-label={`Name of ${type.name}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== type.name && onChange({ name })} />
            <TextInput aria-label={`Folder word for ${type.name}`} className="input mono" style={{ maxWidth: 170 }} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() && label !== type.folderLabel && onChange({ folderLabel: label })} />
          </div>
        ) : (
          <b>{type.name}</b>
        )}
        <small>
          {type.shoots === 0 ? "Not used yet" : `${type.shoots} ${type.shoots === 1 ? "shoot" : "shoots"}`}
          {owner ? "" : ` · folders say “${type.folderLabel}”`}
        </small>
      </div>
      <div className="controls">
        <label className="toggle-row" style={{ gap: 8 }}>
          <span style={{ fontSize: 13 }}>Auto-publish</span>
          <Switch checked={type.autoPublish} disabled={!owner} label={`Auto-publish galleries for ${type.name}`} onChange={(v) => onChange({ autoPublish: v })} />
        </label>
        {owner ? (
          <>
            <span className="reorder">
              <Button size="sm" variant="ghost" className="icon" icon="arrowUp" aria-label={`Move ${type.name} up`} disabled={first} onClick={() => onMove(-1)} />
              <Button size="sm" variant="ghost" className="icon" icon="arrowDown" aria-label={`Move ${type.name} down`} disabled={last} onClick={() => onMove(1)} />
            </span>
            <Button size="sm" variant="ghost" className="icon danger" icon="trash" aria-label={`Remove ${type.name}`} onClick={onRemove} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function StagesPanel() {
  const owner = useOwner();
  const toast = useToast();
  const { data, error, reload } = useLoad<{ stages: LeadStage[] }>("/lead-stages");
  const [name, setName] = useState("");
  const add = useSubmit(() => api("/lead-stages", { body: { name } }));
  const stages = data?.stages ?? [];
  const open = stages.filter((s) => s.kind === "open");

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "bad");
    }
    await reload();
  };
  const reorder = (from: number, to: number) => {
    const ids = open.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    void run(() => api("/lead-stages-order", { method: "PUT", body: { ids } }));
  };

  return (
    <Panel title="Lead stages" description="The columns on your Leads board. Booked and Lost stay at the end; rename them if you like.">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {data === null && !error ? <div className="skeleton" style={{ height: 120 }} aria-busy="true" /> : null}
      <div>
        {stages.map((s) => {
          const i = open.findIndex((o) => o.id === s.id);
          return (
            <div key={s.id} className="item-row">
              <div className="grow">
                {owner ? <StageName stage={s} onRename={(n) => run(() => api(`/lead-stages/${s.id}`, { method: "PATCH", body: { name: n } }))} /> : <b>{s.name}</b>}
                <small>
                  {s.kind === "won" ? "Leads move here when you book the shoot" : s.kind === "lost" ? "Leads move here when you mark them lost" : `${s.leads} ${s.leads === 1 ? "lead" : "leads"}`}
                </small>
              </div>
              <div className="controls">
                {s.kind !== "open" ? <StatusChip tone={s.kind === "won" ? "ok" : "neutral"}>{s.kind === "won" ? "Won" : "Lost"}</StatusChip> : null}
                {owner && s.kind === "open" ? (
                  <>
                    <span className="reorder">
                      <Button size="sm" variant="ghost" className="icon" icon="arrowUp" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => reorder(i, i - 1)} />
                      <Button size="sm" variant="ghost" className="icon" icon="arrowDown" aria-label={`Move ${s.name} down`} disabled={i === open.length - 1} onClick={() => reorder(i, i + 1)} />
                    </span>
                    <Button size="sm" variant="ghost" className="icon danger" icon="trash" aria-label={`Remove ${s.name}`} onClick={() => run(() => api(`/lead-stages/${s.id}`, { method: "DELETE" }))} />
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {owner ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await add.submit()) {
              setName("");
              await reload();
            }
          }}
          noValidate
          className="input-row"
        >
          <TextInput aria-label="New stage" placeholder="Add a stage, like “Waiting on deposit”" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" icon="plus" loading={add.busy} disabled={!name.trim()}>
            Add
          </Button>
        </form>
      ) : null}
      {add.error ? <Callout tone="bad">{add.error}</Callout> : null}
    </Panel>
  );
}

function StageName({ stage, onRename }: { stage: LeadStage; onRename: (name: string) => void }) {
  const [name, setName] = useState(stage.name);
  useEffect(() => setName(stage.name), [stage.name]);
  return <TextInput aria-label={`Name of stage ${stage.name}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== stage.name && onRename(name)} />;
}
