import { useState } from "react";
import { Avatar, Button, Field, Icon, Spinner, TextInput } from "@openportrait/ui";
import { useDebounced, useLoad } from "../lib/useLoad.js";
import type { ContactSummary } from "../lib/types.js";
import { ContactDialog } from "./ContactDialog.js";

export interface PickedContact {
  id: string;
  name: string;
}

/** Find an existing contact by name, email or phone, or add a new one without leaving the form. */
export function ContactPicker({ value, onChange, label = "Client", error }: { value: PickedContact | null; onChange: (c: PickedContact | null) => void; label?: string; error?: string | null }) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const term = useDebounced(q.trim());
  const { data, loading } = useLoad<{ items: ContactSummary[] }>(value || !term ? null : `/contacts?limit=6&q=${encodeURIComponent(term)}`);

  if (value) {
    return (
      <div className="field">
        <span className="label">{label}</span>
        <div className="picked">
          <Avatar name={value.name} size={32} />
          <b>{value.name}</b>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  const results = term ? (data?.items ?? []) : [];
  const typedLooksLikeEmail = term.includes("@");
  return (
    <div className="field">
      <Field label={label} error={error} hint="Search by name, email or phone.">
        {(p) => (
          <div className="search">
            <Icon name="search" />
            <TextInput {...p} type="search" autoComplete="off" placeholder="Start typing…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
      </Field>
      {term ? (
        <div className="picker-list" role="listbox" aria-label="Matching contacts">
          {loading && !results.length ? (
            <div className="picker-note">
              <Spinner label="Searching" /> Searching…
            </div>
          ) : null}
          {results.map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={false} className="picker-item" onClick={() => onChange({ id: c.id, name: c.name })}>
              <Avatar name={c.name} size={30} />
              <span>
                <b>{c.name}</b>
                <small>{[c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone"}</small>
              </span>
            </button>
          ))}
          <button type="button" className="picker-item add" onClick={() => setAdding(true)}>
            <span className="plus">
              <Icon name="plus" />
            </span>
            <span>
              <b>Add “{term}” as a new contact</b>
            </span>
          </button>
        </div>
      ) : null}
      <ContactDialog
        open={adding}
        onClose={() => setAdding(false)}
        initial={typedLooksLikeEmail ? { email: term } : { firstName: term.split(/\s+/)[0] ?? "", lastName: term.split(/\s+/).slice(1).join(" ") }}
        onSaved={(c) => {
          setAdding(false);
          setQ("");
          onChange(c);
        }}
      />
    </div>
  );
}
