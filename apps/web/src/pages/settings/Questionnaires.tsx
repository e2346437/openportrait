import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Panel, Spinner, TextArea, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { FIELD_TYPE_LABEL, type FieldType, type QuestionField, type Starter, type Template, type TypeDefault } from "../../lib/questionnaires.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { QuestionnairePreview } from "../../components/QuestionnairePreview.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { RichTextEditor } from "../../components/RichTextEditor.js";

interface Loaded {
  items: Template[];
  defaults: TypeDefault[];
  starters: Starter[];
}
interface ShootTypeRow {
  id: string;
  name: string;
}

/** Build the forms clients fill in, and choose which shoot types get which form. */
export function QuestionnairesSettingsPage() {
  const { data, error, reload } = useLoad<Loaded>("/questionnaire-templates");
  const [editing, setEditing] = useState<{ template: Template | null; seed?: Starter } | null>(null);
  const [picking, setPicking] = useState(false);
  const [previewing, setPreviewing] = useState<Template | null>(null);
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();

  if (error && !data) return <Callout tone="bad">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;

  const remove = async (t: Template) => {
    const r = await api<{ removed: boolean }>(`/questionnaire-templates/${t.id}`, { method: "DELETE" });
    toast(r.removed ? "Removed" : "Removed. Copies already sent keep their answers.");
    reload();
  };

  return (
    <div className="stack">
      <Panel
        title="Questionnaires"
        description="Forms your clients fill in, like a wedding timeline or a headshot style guide. Their answers are saved on the shoot."
        actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setPicking(true)}>New questionnaire</Button> : null}
        flush
      >
        {data.items.length === 0 ? (
          <EmptyState icon="note" title="No questionnaires yet" action={owner ? <Button variant="primary" icon="plus" onClick={() => setPicking(true)}>Create your first</Button> : undefined}>
            Start from a ready-made form for weddings, portraits or headshots, or build your own from scratch. You can change every question.
          </EmptyState>
        ) : (
          <ul className="catalog-list q-templates">
            {data.items.map((t) => (
              <li key={t.id}>
                <span className="cat-main">
                  <b>{t.name}</b>
                  <small>
                    {t.questions} {t.questions === 1 ? "question" : "questions"} · sent {t.sent} {t.sent === 1 ? "time" : "times"}
                    {t.usedBy.length ? ` · default for ${t.usedBy.map((u) => u.name).join(", ")}` : ""}
                  </small>
                </span>
                <span />
                <span />
                <span className="cat-actions">
                  <Button size="sm" icon="eye" onClick={() => setPreviewing(t)}>Preview</Button>
                  {owner ? <Button size="sm" onClick={() => setEditing({ template: t })}>Edit</Button> : null}
                  {owner ? <Button size="sm" variant="ghost" onClick={() => remove(t)}>Remove</Button> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data.items.length > 0 ? <DefaultsPanel templates={data.items} defaults={data.defaults} owner={owner} onChanged={reload} /> : null}

      <Dialog open={!!previewing} onClose={() => setPreviewing(null)} wide title="What your client sees" description={previewing ? `${previewing.name}. Try it like a client would.` : undefined}>
        {previewing ? <PreviewBody template={previewing} /> : null}
      </Dialog>
      <StarterDialog open={picking} starters={data.starters} onClose={() => setPicking(false)} onPick={(seed) => { setPicking(false); setEditing({ template: null, seed }); }} />
      <BuilderDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
          toast("Saved");
        }}
      />
    </div>
  );
}

function PreviewBody({ template }: { template: Template }) {
  const { me } = useSession();
  return <QuestionnairePreview studio={me?.studio.name ?? ""} title={template.name} intro={template.intro ?? ""} fields={template.fields as QuestionField[]} />;
}

function DefaultsPanel({ templates, defaults, owner, onChanged }: { templates: Template[]; defaults: TypeDefault[]; owner: boolean; onChanged: () => void }) {
  const toast = useToast();
  const types = useLoad<{ types: ShootTypeRow[] }>("/shoot-types");
  const [saving, setSaving] = useState<string | null>(null);
  const byType = new Map(defaults.map((d) => [d.shootTypeId, d]));

  const save = async (typeId: string, templateId: string | null, sendMode: "manual" | "on_booking") => {
    setSaving(typeId);
    try {
      await api(`/shoot-types/${typeId}/questionnaire`, { method: "PUT", body: { templateId, sendMode } });
      toast(templateId ? (sendMode === "on_booking" ? "Will be sent automatically when a shoot is booked" : "Saved. You'll send it by hand") : "Questionnaire removed from this shoot type");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save that", "bad");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Panel title="Which questionnaire goes with each shoot type" description="Pick a form for each type of shoot. It can be sent automatically the moment a shoot is booked, or kept ready for you to send.">
      {types.error ? <Callout tone="bad">{types.error}</Callout> : null}
      {!types.data ? <Spinner label="Loading" /> : (
        <ul className="q-defaults">
          {types.data.types.map((t) => {
            const d = byType.get(t.id);
            return (
              <li key={t.id}>
                <b>{t.name}</b>
                <select className="input" aria-label={`Questionnaire for ${t.name}`} disabled={!owner || saving === t.id} value={d?.templateId ?? ""} onChange={(e) => save(t.id, e.target.value || null, d?.sendMode ?? "manual")}>
                  <option value="">None</option>
                  {templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                {d ? (
                  <SwitchRow checked={d.sendMode === "on_booking"} onChange={(v) => save(t.id, d.templateId, v ? "on_booking" : "manual")} label="Send when booked" />
                ) : <span />}
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">Automatic sending emails the client's main contact as soon as a shoot is created. It needs their email address and your email settings. Without them, the questionnaire waits as a draft on the shoot.</p>
    </Panel>
  );
}

function StarterDialog({ open, starters, onClose, onPick }: { open: boolean; starters: Starter[]; onClose: () => void; onPick: (s: Starter | undefined) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Start a questionnaire" description="Pick a starting point. You can add, remove and reword anything afterwards.">
      <ul className="q-starters">
        {starters.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => onPick(s)}>
              <b>{s.name}</b>
              <small>{s.description}</small>
              <span>{s.fields.filter((f) => f.type !== "heading").length} questions</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => onPick(undefined)}>
            <b>Blank form</b>
            <small>Write your own questions.</small>
            <span>Start empty</span>
          </button>
        </li>
      </ul>
    </Dialog>
  );
}

const uid = () => `q${Math.random().toString(36).slice(2, 10)}`;
const blank = (type: FieldType): QuestionField => ({ id: uid(), type, label: "", ...(type === "select" || type === "multiselect" ? { options: ["", ""] } : {}) });
const hasOptions = (t: FieldType) => t === "select" || t === "multiselect";
const ADDABLE: FieldType[] = ["text", "textarea", "select", "multiselect", "yesno", "date", "number", "heading"];

function BuilderDialog({ target, onClose, onSaved }: { target: { template: Template | null; seed?: Starter } | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [intro, setIntro] = useState("");
  const [fields, setFields] = useState<QuestionField[]>([]);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const { me } = useSession();
  const editing = target?.template ?? null;

  useEffect(() => {
    if (!target) return;
    setTab("edit");
    const src = target.template ?? target.seed;
    setName(src?.name ?? "");
    setIntro(src?.intro ?? "");
    setFields(((target.template?.fields ?? target.seed?.fields) ?? [blank("text")]).map((f) => ({ ...(f as QuestionField), id: (f as QuestionField).id ?? uid() })));
  }, [target]);

  const patch = (i: number, p: Partial<QuestionField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const move = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const j = i + d;
      if (j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const changeType = (i: number, type: FieldType) => patch(i, { type, options: hasOptions(type) ? (fields[i]?.options?.length ? fields[i]!.options : ["", ""]) : undefined, required: type === "heading" ? false : fields[i]?.required });

  const { busy, error, submit } = useSubmit(() => {
    const body = {
      name,
      intro: intro || null,
      fields: fields.map((f) => ({ ...f, options: hasOptions(f.type) ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined })),
    };
    return editing ? api(`/questionnaire-templates/${editing.id}`, { method: "PUT", body }) : api("/questionnaire-templates", { body });
  });
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) onSaved();
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      wide
      title={editing ? "Edit questionnaire" : "New questionnaire"}
      description={editing && editing.sent ? "Copies already sent keep the questions they were sent with." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="q-form" type="submit" loading={busy}>Save questionnaire</Button>
        </>
      }
    >
      <div className="seg q-tabs" role="group" aria-label="Editor or preview">
        <button type="button" aria-pressed={tab === "edit"} onClick={() => setTab("edit")}>Edit</button>
        <button type="button" aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>Preview as client</button>
      </div>
      {tab === "preview" ? (
        <QuestionnairePreview studio={me?.studio.name ?? ""} title={name} intro={intro} fields={fields.map((f) => ({ ...f, options: hasOptions(f.type) ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined }))} />
      ) : null}
      <form id="q-form" onSubmit={go} noValidate className="q-builder" hidden={tab === "preview"}>
        {error ? <Callout tone="bad">{error}</Callout> : null}
        <div className="form-grid">
          <Field className="span-2" label="Name" hint="You'll see this in your list. Clients see it as the title.">{(p) => <TextInput {...p} autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
          <div className="span-2 field">
            <span className="label" id="q-intro">Message above the questions</span>
            <RichTextEditor variant="compact" labelledBy="q-intro" value={intro} onChange={setIntro} placeholder="Optional. A friendly note about why you're asking." />
          </div>
        </div>

        <ol className="q-cards">
          {fields.map((f, i) => (
            <li key={f.id} className={`q-card${f.type === "heading" ? " is-heading" : ""}`}>
              <div className="q-card-head">
                <select className="input sm" aria-label={`Type of question ${i + 1}`} value={f.type} onChange={(e) => changeType(i, e.target.value as FieldType)}>
                  {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
                </select>
                <span className="q-card-tools">
                  <Button size="sm" variant="ghost" className="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><span aria-hidden>↑</span></Button>
                  <Button size="sm" variant="ghost" className="icon" aria-label="Move down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}><span aria-hidden>↓</span></Button>
                  <Button size="sm" variant="ghost" className="icon" icon="trash" aria-label="Remove this question" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} />
                </span>
              </div>
              <TextInput aria-label={f.type === "heading" ? "Section title" : "Question"} placeholder={f.type === "heading" ? "Section title, like “The day”" : "Your question"} maxLength={300} value={f.label} onChange={(e) => patch(i, { label: e.target.value })} />
              {f.type !== "heading" ? (
                <>
                  <TextInput aria-label="Help text" className="q-help" placeholder="Help text under the question (optional)" maxLength={500} value={f.help ?? ""} onChange={(e) => patch(i, { help: e.target.value })} />
                  {hasOptions(f.type) ? (
                    <Field label="Choices" hint="One per line.">
                      {(p) => (
                        <TextArea
                          {...p}
                          rows={Math.min(8, Math.max(3, (f.options?.length ?? 2) + 1))}
                          value={(f.options ?? []).join("\n")}
                          onChange={(e) => patch(i, { options: e.target.value.split("\n") })}
                        />
                      )}
                    </Field>
                  ) : null}
                  <SwitchRow checked={!!f.required} onChange={(v) => patch(i, { required: v })} label="Required" />
                </>
              ) : null}
            </li>
          ))}
        </ol>

        <div className="q-add" role="group" aria-label="Add a question">
          <span>Add</span>
          {ADDABLE.map((t) => (
            <Button key={t} size="sm" icon="plus" onClick={() => setFields((fs) => [...fs, blank(t)])}>{FIELD_TYPE_LABEL[t]}</Button>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

