import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Panel, Spinner, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { EXAMPLE_CONTRACT } from "../../lib/contracts.js";
import { plainPreview, toEditorHtml } from "../../lib/richtext.js";
import { RichTextEditor } from "../../components/RichTextEditor.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";

interface Template {
  id: string;
  name: string;
  body: string;
  archivedAt: string | number | null;
}

/** Contract wording you reuse. Merge fields like {{client.name}} are filled in for each client. */
export function ContractTemplatesPage() {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ items: Template[] }>("/contract-templates");
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const items = data?.items ?? [];
  const archive = async (t: Template) => {
    await api(`/contract-templates/${t.id}/archive`, { body: { archived: true } });
    toast("Archived. Contracts already made from it are unchanged.");
    reload();
  };
  return (
    <Panel
      title="Contract templates"
      description="Write your agreement once. Each contract you make from it has the client's details filled in, and it can't change after it's signed."
      actions={owner ? <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>Add</Button> : null}
      flush
    >
      {error ? <div className="pad"><Callout tone="bad">{error}</Callout></div> : null}
      {loading && !data ? <div className="pad"><Spinner label="Loading" /></div> : null}
      {data && items.length === 0 ? (
        <EmptyState icon="note" title="No templates yet" action={owner ? <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Write your first template</Button> : undefined}>
          Start from our example and change it to fit your studio, or paste in your own wording.
        </EmptyState>
      ) : (
        <ul className="catalog-list">
          {items.map((t) => (
            <li key={t.id}>
              <span className="cat-main">
                <b>{t.name}</b>
                <small>{plainPreview(t.body)}</small>
              </span>
              <span />
              <span />
              {owner ? (
                <span className="cat-actions">
                  <Button size="sm" onClick={() => setEditing(t)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => archive(t)}>Archive</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <TemplateDialog target={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); toast("Saved"); }} />
    </Panel>
  );
}

function TemplateDialog({ target, onClose, onSaved }: { target: Template | "new" | null; onClose: () => void; onSaved: () => void }) {
  const fields = useLoad<{ fields: Array<{ key: string; label: string }> }>("/contract-fields").data?.fields ?? [];
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (!target) return;
    setName(target === "new" ? "" : target.name);
    setBody(target === "new" ? "" : toEditorHtml(target.body));
  }, [target]);
  const editing = target && target !== "new" ? target : null;
  const { busy, error, submit } = useSubmit(() => (editing ? api(`/contract-templates/${editing.id}`, { method: "PUT", body: { name, body } }) : api("/contract-templates", { body: { name, body } })));
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) onSaved();
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      wide
      title={editing ? "Edit template" : "New template"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="tpl-form" type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="tpl-form" onSubmit={go} noValidate className="form-grid">
        {error ? <div className="span-2"><Callout tone="bad">{error}</Callout></div> : null}
        <Field className="span-2" label="Name">{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Wedding agreement" />}</Field>
        <div className="span-2 field">
          <span className="label" id="tpl-wording">Wording</span>
          <RichTextEditor variant="full" labelledBy="tpl-wording" value={body} onChange={setBody} fields={fields} placeholder="Write your agreement, or start from the example below." />
          <small className="hint">Use “Insert field” to drop in details that are filled in for each client, like their name or the shoot date.</small>
        </div>
        {!body ? <div className="span-2"><Button type="button" size="sm" onClick={() => { setBody(toEditorHtml(EXAMPLE_CONTRACT)); if (!name) setName("Photography services agreement"); }}>Start from an example</Button></div> : null}
        <p className="span-2 hint">The example is a starting point only. Have a lawyer review your agreement before you use it with clients.</p>
      </form>
    </Dialog>
  );
}
