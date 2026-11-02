import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Avatar, Button, Callout, Dialog, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";
import { useSubmit } from "../lib/useForm.js";
import type { ContactDetail } from "../lib/types.js";
import { ContactPicker, type PickedContact } from "./ContactPicker.js";

/** A contact's household: the other people who share their home or company. Join by picking someone already in the studio. */
export function HouseholdPanel({ contact, onChanged }: { contact: Pick<ContactDetail, "id" | "name" | "household">; onChanged: () => void }) {
  const toast = useToast();
  const h = contact.household;
  const [joining, setJoining] = useState(false);
  const [other, setOther] = useState<PickedContact | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(h?.name ?? "");
  useEffect(() => setName(h?.name ?? ""), [h?.name]);

  const join = useSubmit(async () => {
    if (!other) throw new Error("Choose who they belong with.");
    await api(`/contacts/${contact.id}/household`, { method: "PUT", body: { withContactId: other.id } });
    setJoining(false);
    setOther(null);
    toast("Household updated");
    onChanged();
  });
  const rename = useSubmit(async () => {
    await api(`/households/${h!.id}`, { method: "PATCH", body: { name } });
    setRenaming(false);
    onChanged();
  });
  const leave = async () => {
    try {
      await api(`/contacts/${contact.id}/household`, { method: "DELETE" });
      toast(`${contact.name} left the household`);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't work.", "bad");
    }
  };

  return (
    <Panel
      title="Household"
      description={h ? undefined : "Group people who share a home or a company."}
      actions={<Button size="sm" icon={h ? "edit" : "plus"} onClick={() => setJoining(true)}>{h ? "Move" : "Add"}</Button>}
    >
      {h ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className="household-name">
            <b>{h.name}</b>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>Rename</Button>
          </div>
          {h.members.length ? (
            <ul className="household-members">
              {h.members.map((m) => (
                <li key={m.id}>
                  <Link to={`/studio/clients/${m.id}`}>
                    <Avatar name={m.name} size={28} />
                    <span>
                      <b>{m.name}</b>
                      {m.email ? <small>{m.email}</small> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nobody else yet.</p>
          )}
          <div><Button size="sm" variant="ghost" onClick={leave}>Remove {contact.name} from this household</Button></div>
        </div>
      ) : (
        <p className="muted">Not in a household. Add them next to a partner, parent or colleague and each will see the other here.</p>
      )}

      <Dialog
        open={joining}
        onClose={() => setJoining(false)}
        title={h ? "Move to another household" : "Add to a household"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setJoining(false)}>Cancel</Button>
            <Button variant="primary" loading={join.busy} disabled={!other} onClick={() => join.submit()}>Add to their household</Button>
          </>
        }
      >
        {join.error ? <Callout tone="bad">{join.error}</Callout> : null}
        <p className="muted">Pick someone. {contact.name} joins their household, which is made if they don't have one yet.</p>
        <ContactPicker label="Belongs with" value={other} onChange={setOther} />
      </Dialog>

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename household"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" loading={rename.busy} disabled={!name.trim()} onClick={() => rename.submit()}>Save</Button>
          </>
        }
      >
        {rename.error ? <Callout tone="bad">{rename.error}</Callout> : null}
        <TextInput aria-label="Household name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </Dialog>
    </Panel>
  );
}
