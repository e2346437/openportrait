import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, Callout, Dialog, Field, TextArea, TextInput, useToast } from "@openportrait/ui";
import { plural, type GalleryDetail } from "../lib/galleries.js";
import type { Patch } from "../pages/galleries/GalleryDetail.js";

/** Emails the gallery link to the shoot's people and anyone else the studio adds. */
export function EmailDialog({ open, onClose, data, patch }: { open: boolean; onClose: () => void; data: GalleryDetail; patch: Patch }) {
  const toast = useToast();
  const { recipients, emailReady } = data;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPicked(new Set(recipients.map((r) => r.email)));
      setExtra("");
      setError(null);
    }
  }, [open, recipients]);

  const extras = extra.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const invalid = extras.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const to = [...recipients.filter((r) => picked.has(r.email)).map((r) => ({ email: r.email, name: r.name })), ...extras.filter((e) => !recipients.some((r) => r.email === e)).map((email) => ({ email }))];

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await patch("/email", { to, message: note }, "POST");
      if (!next) return;
      const results = (next as unknown as { results?: Array<{ ok: boolean; email: string; error?: string }> }).results ?? [];
      const bad = results.filter((r) => !r.ok);
      if (bad.length) setError(`${bad[0]!.email}: ${bad[0]!.error ?? "couldn't be sent."}`);
      else {
        toast(`Emailed ${plural(results.length, "person", "people")}`);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Email the gallery link"
      description="Each person gets their own email with a button to open the gallery."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="send" loading={busy} disabled={!emailReady || to.length === 0 || !!invalid} onClick={send}>
            {to.length ? `Send to ${plural(to.length, "person", "people")}` : "Send"}
          </Button>
        </>
      }
    >
      {!emailReady ? (
        <Callout tone="info" title="Email isn't set up yet" action={<Link className="btn sm" to="/studio/settings/email" onClick={onClose}>Set up email</Link>}>
          Add your mail server details first. Until then, copy the link from Sharing options and send it yourself.
        </Callout>
      ) : null}
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {recipients.length ? (
        <fieldset className="stack-sm">
          <legend className="label">People on this shoot</legend>
          <ul className="mail-pick">
            {recipients.map((r) => (
              <li key={r.email}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(r.email)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(r.email);
                        else n.delete(r.email);
                        return n;
                      })
                    }
                  />
                  <span className="who">
                    <b>{r.name}</b>
                    <span>{r.email}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <Field label={recipients.length ? "Anyone else" : "Send to"} error={invalid ? `“${invalid}” isn't a valid email address.` : null} hint="Separate several addresses with commas.">
        {(p) => <TextInput {...p} type="text" inputMode="email" autoComplete="off" value={extra} placeholder="name@example.com" onChange={(e) => setExtra(e.target.value)} />}
      </Field>
      <Field label="Add a personal note" hint="Optional. It's added to the standard message you set up in Settings › Email.">
        {(p) => <TextArea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
