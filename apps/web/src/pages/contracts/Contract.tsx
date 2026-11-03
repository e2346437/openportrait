import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Callout, CopyValue, Field, Icon, PageHeader, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { contractLabel, contractTone, type ContractDetail } from "../../lib/contracts.js";
import { useSession } from "../../lib/session.js";
import { formatDateTime, ms } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { EmailOffCallout } from "../../components/EmailOffCallout.js";
import { isHtml } from "../../lib/richtext.js";
import { RichTextEditor } from "../../components/RichTextEditor.js";

/** One contract: read it, adjust a draft, send it, and once it is signed, countersign and download it. */
export function ContractPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const tz = me?.studio.timezone ?? "UTC";
  const { data: c, error, reload, setData } = useLoad<ContractDetail>(`/contracts/${id}`);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (c) {
      setTitle(c.title);
      setBody(c.body);
    }
  }, [c?.id, c?.bodyHash]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useSubmit(() => api<ContractDetail>(`/contracts/${id}`, { method: "PUT", body: { title, body } }));
  const send = useSubmit(async () => {
    if (c && (title !== c.title || body !== c.body)) await api(`/contracts/${id}`, { method: "PUT", body: { title, body } });
    return api<ContractDetail & { emailed: boolean }>(`/contracts/${id}/send`, { method: "POST" });
  });
  const act = async (path: string, done: string, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    try {
      setData(await api<ContractDetail>(`/contracts/${id}/${path}`, { method: "POST" }));
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "bad");
    }
  };
  const back = (
    <Link to="/studio/contracts" className="back">
      <Icon name="arrowLeft" /> Contracts
    </Link>
  );
  if (error) return <>{back}<Callout tone="bad" title="Couldn't open this contract">{error}</Callout></>;
  if (!c) return <>{back}<Spinner label="Loading" /></>;
  const draft = c.state === "draft";
  const link = c.link.startsWith("/") ? window.location.origin + c.link : c.link;
  const when = (v: string | number | null) => (v ? formatDateTime(ms(v), tz) : "");

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const r = await save.submit();
    if (r) {
      setData(r);
      toast("Saved");
    }
  };
  const onSend = async () => {
    const r = await send.submit();
    if (!r) return;
    toast(r.emailed ? `Sent to ${c.contactName}.` : "Marked as sent. Email isn't set up, so copy the link and send it yourself.");
    reload();
  };
  const onDelete = async () => {
    if (!window.confirm("Delete this draft?")) return;
    await api(`/contracts/${id}`, { method: "DELETE" });
    toast("Draft deleted");
    navigate("/studio/contracts", { replace: true });
  };

  return (
    <div className="stack">
      {back}
      <PageHeader title={c.title} description={<>For <Link to={`/studio/clients/${c.contactId}`}>{c.contactName}</Link></>} actions={<StatusChip tone={contractTone(c.state)}>{contractLabel[c.state]}</StatusChip>} />
      <div className="split">
        <div className="stack">
          {draft ? (
            <Panel title="Wording" description="This is the exact text the client will sign. Merge fields were already filled in. Editing here changes only this contract.">
              <form onSubmit={onSave} noValidate className="form-grid">
                {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
                <Field className="span-2" label="Title">{(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
                <div className="span-2 field">
                  <span className="label" id="draft-wording">Text</span>
                  <RichTextEditor variant="full" labelledBy="draft-wording" value={body} onChange={setBody} />
                </div>
                <div className="span-2 form-actions">
                  <Button type="submit" loading={save.busy}>Save changes</Button>
                </div>
              </form>
            </Panel>
          ) : (
            <Panel title="Wording">
              <ContractText text={c.body} />
            </Panel>
          )}
        </div>
        <aside className="stack">
          {draft ? (
            <Panel title="Send it" description={c.contactEmail ? `Emails ${c.contactName} (${c.contactEmail}) a private link to review and sign. Any changes you've typed are saved first.` : `${c.contactName} has no email address. Add one to their contact first.`}>
              {send.error ? <Callout tone="bad">{send.error}</Callout> : null}
              <EmailOffCallout>The contract can't be emailed until email is set up.</EmailOffCallout>
              <div className="form-actions">
                <Button variant="primary" icon="send" loading={send.busy} disabled={!c.contactEmail} onClick={onSend}>Send for signature</Button>
                <Button variant="ghost" className="danger" onClick={onDelete}>Delete draft</Button>
              </div>
            </Panel>
          ) : null}
          {c.state === "sent" ? (
            <Panel title="Waiting for the client" description={c.viewedAt ? `Opened ${when(c.viewedAt)}.` : "Not opened yet."}>
              <div className="stack-tight">
                <CopyValue value={link} label="Client link" />
                <Button block variant="ghost" className="danger" onClick={() => act("void", "Voided.", "Void this contract? The client's link will stop working.")}>Void contract</Button>
              </div>
            </Panel>
          ) : null}
          {c.state === "signed" || c.state === "countersigned" ? (
            <Panel title="Signed" description={`${c.signerName} signed ${when(c.signedAt)}.`}>
              <div className="stack-tight">
                {c.countersignedAt ? <Callout tone="ok" title={`Countersigned by ${c.countersignedBy}`}>{when(c.countersignedAt)}</Callout> : null}
                {!c.countersignedAt && owner ? <Button block variant="primary" onClick={() => act("countersign", "Countersigned.")}>Countersign as the studio</Button> : null}
                {c.hasPdf ? (
                  <a className="btn block" href={`/api/studio/contracts/${c.id}/pdf`} download>
                    <Icon name="download" /> Download signed PDF
                  </a>
                ) : null}
                <p className="hint">The PDF has an audit trail page: who signed, when, from which address, and a fingerprint of the exact text.</p>
              </div>
            </Panel>
          ) : null}
          {c.state === "void" ? <Callout tone="bad" title="Voided">The client's link no longer works.</Callout> : null}
          <p className="hint">Text fingerprint (SHA-256)<br /><code className="wrap-code">{c.bodyHash}</code></p>
        </aside>
      </div>
    </div>
  );
}

/** A contract's text, with lines that start with # shown as headings. */
export function ContractText({ text }: { text: string }) {
  // Formatted wording is cleaned on the server before it is saved and again before it is shown.
  if (isHtml(text)) return <div className="contract-doc rich" dangerouslySetInnerHTML={{ __html: text }} />;
  return (
    <div className="contract-doc">
      {text.split("\n").map((line, i) => (line.startsWith("# ") ? <h3 key={i}>{line.slice(2)}</h3> : line.trim() ? <p key={i}>{line}</p> : null))}
    </div>
  );
}
