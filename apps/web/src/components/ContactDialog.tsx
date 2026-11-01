import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Dialog, Field, TextInput } from "@openportrait/ui";
import { api } from "../lib/api.js";
import type { ContactFields } from "../lib/types.js";
import { useSubmit } from "../lib/useForm.js";

const blank: ContactFields = { firstName: "", lastName: "", email: "", phone: "", company: "", addressLine1: "", addressLine2: "", city: "", region: "", postalCode: "", country: "", source: "" };

type Initial = Partial<{ [K in keyof ContactFields]: string | null }>;

/** Add or edit a contact. `initial` pre-fills (for example from what was typed into a search box). */
export function ContactDialog({
  open,
  onClose,
  onSaved,
  contactId,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (contact: { id: string; name: string }) => void;
  contactId?: string;
  initial?: Initial;
}) {
  const [form, setForm] = useState<ContactFields>(blank);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const next = { ...blank, ...Object.fromEntries(Object.entries(initial ?? {}).map(([k, v]) => [k, v ?? ""])) } as ContactFields;
    setForm(next);
    setMoreOpen(Boolean(next.addressLine1 || next.city || next.postalCode || next.country));
    // Only reset when the dialog opens, so typing is never overwritten by a re-render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  type Saved = { id: string; name?: string; firstName?: string; lastName?: string; email?: string | null; company?: string | null };
  const { busy, error, fieldErrors, submit } = useSubmit(() => (contactId ? api<Saved>(`/contacts/${contactId}`, { method: "PATCH", body: form }) : api<Saved>("/contacts", { body: form })));
  const set = (key: keyof ContactFields) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const saved = await submit();
    if (!saved) return;
    const name = saved.name ?? (`${saved.firstName ?? ""} ${saved.lastName ?? ""}`.trim() || saved.company || saved.email || "Contact");
    onSaved({ id: saved.id, name });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={contactId ? "Edit contact" : "Add a contact"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="contact-form" loading={busy}>
            {contactId ? "Save changes" : "Add contact"}
          </Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={onSubmit} noValidate className="form-grid">
        {error ? (
          <div className="span-2">
            <Callout tone="bad">{error}</Callout>
          </div>
        ) : null}
        <Field label="First name" error={fieldErrors.firstName}>
          {(p) => <TextInput {...p} autoComplete="off" autoFocus value={form.firstName} onChange={set("firstName")} />}
        </Field>
        <Field label="Last name" error={fieldErrors.lastName}>
          {(p) => <TextInput {...p} autoComplete="off" value={form.lastName} onChange={set("lastName")} />}
        </Field>
        <Field label="Email" error={fieldErrors.email}>
          {(p) => <TextInput {...p} type="email" autoComplete="off" value={form.email ?? ""} onChange={set("email")} />}
        </Field>
        <Field label="Phone" error={fieldErrors.phone}>
          {(p) => <TextInput {...p} type="tel" autoComplete="off" value={form.phone ?? ""} onChange={set("phone")} />}
        </Field>
        <Field label="Company" hint="Optional" error={fieldErrors.company}>
          {(p) => <TextInput {...p} autoComplete="off" value={form.company ?? ""} onChange={set("company")} />}
        </Field>
        <Field label="How they found you" hint="Referral, Instagram, a past client…" error={fieldErrors.source}>
          {(p) => <TextInput {...p} autoComplete="off" value={form.source ?? ""} onChange={set("source")} />}
        </Field>
        <div className="span-2">
          <Button variant="ghost" size="sm" iconRight="chevronDown" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            {moreOpen ? "Hide address" : "Add an address"}
          </Button>
        </div>
        {moreOpen ? (
          <>
            <Field className="span-2" label="Address">
              {(p) => <TextInput {...p} autoComplete="off" value={form.addressLine1 ?? ""} onChange={set("addressLine1")} />}
            </Field>
            <Field className="span-2" label="Address line 2">
              {(p) => <TextInput {...p} autoComplete="off" value={form.addressLine2 ?? ""} onChange={set("addressLine2")} />}
            </Field>
            <Field label="City">{(p) => <TextInput {...p} autoComplete="off" value={form.city ?? ""} onChange={set("city")} />}</Field>
            <Field label="State or region">{(p) => <TextInput {...p} autoComplete="off" value={form.region ?? ""} onChange={set("region")} />}</Field>
            <Field label="Postal code">{(p) => <TextInput {...p} autoComplete="off" value={form.postalCode ?? ""} onChange={set("postalCode")} />}</Field>
            <Field label="Country">{(p) => <TextInput {...p} autoComplete="off" value={form.country ?? ""} onChange={set("country")} />}</Field>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
