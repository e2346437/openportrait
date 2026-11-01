import { useEffect, useState } from "react";
import { Button, Callout, Dialog, Field, Icon, StatusChip, TextArea, TextInput, useToast } from "@openportrait/ui";
import { Link } from "react-router";
import { api } from "../lib/api.js";
import { plural, timeAgo } from "../lib/galleries.js";

interface Panel {
  configured: boolean;
  live: boolean;
  hasUrl: boolean;
  recipients: Array<{ name: string; email: string }>;
  subject: string;
  message: string;
  link: string;
  sent: Array<{ id: string; to: string; subject: string; kind: string; status: "queued" | "sent" | "failed"; error: string | null; createdAt: number }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails the private gallery link to the people on the shoot (or any address), and shows what was already sent. */
export function EmailDialog({ open, onClose, galleryId }: { open: boolean; onClose: () => void; galleryId: string }) {
  const toast = useToast();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setExtra("");
    void api<Panel>(`/galleries/${galleryId}/email`)
      .then((p) => {
        setPanel(p);
        setPicked(new Set(p.recipients.slice(0, 1).map((r) => r.email)));
        setSubject(p.subject);
        setMessage(p.message);
      })
      .catch((e: Error) => setError(e.message));
  }, [open, galleryId]);

  const extras = extra.split(/[\s,;]+/).filter(Boolean);
  const to = [...picked, ...extras];
  const bad = extras.find((x) => !EMAIL.test(x));
  const blocker = panel && (!panel.configured ? "email" : !panel.live ? "live" : !panel.hasUrl ? "url" : null);

  const send = async () => {
    if (bad) return setError(`"${bad}" isn't a valid email address.`);
    setBusy(true);
    setError("");
    try {
      const r = await api<Panel & { queued: number }>(`/galleries/${galleryId}/email`, { method: "POST", body: { to, subject, message } });
      setPanel(r);
      setExtra("");
      toast(`Sending to ${plural(r.queued, "person", "people")}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} wide title="Email the gallery link" description="The email has a button that opens the private gallery page. Nothing is sent until you press Send.">
      {!panel && !error ? <p className="hint">Loading…</p> : null}
      {blocker === "email" ? (
        <Callout tone="warn" title="Email isn't set up yet" action={<Link className="btn sm" to="/studio/settings/email">Set up email</Link>}>
          Add your email account first, so OpenPortrait can send as you.
        </Callout>
      ) : blocker === "live" ? (
        <Callout tone="warn" title="Share the gallery first">
          The link only works once the gallery is shared. Use Share with client, then come back.
        </Callout>
      ) : blocker === "url" ? (
        <Callout tone="warn" title="Add your public address first" action={<Link className="btn sm" to="/studio/settings/internet">Open settings</Link>}>
          Links in emails need your public web address, or clients couldn't open them.
        </Callout>
      ) : null}

      {panel && !blocker ? (
        <div className="em-form">
          <fieldset className="em-to">
            <legend className="label">To</legend>
            {panel.recipients.length ? (
              panel.recipients.map((r) => (
                <label key={r.email} className="em-pick">
                  <input
                    type="checkbox"
                    checked={picked.has(r.email)}
                    onChange={() =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (n.has(r.email)) n.delete(r.email);
                        else n.add(r.email);
                        return n;
                      })
                    }
                  />
                  <span>
                    <b>{r.name}</b> <span className="mono">{r.email}</span>
                  </span>
                </label>
              ))
            ) : (
              <p className="hint">No contacts with an email are linked to this gallery's shoot yet. Type an address below.</p>
            )}
            <Field label={panel.recipients.length ? "Add another address" : "Email address"} hint="Separate several with commas.">
              {(p) => <TextInput {...p} type="email" multiple placeholder="name@example.com" value={extra} onChange={(e) => setExtra(e.target.value)} />}
            </Field>
          </fieldset>
          <Field label="Subject">{(p) => <TextInput {...p} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />}</Field>
          <Field label="Message" hint="A “View your gallery” button is added under your message.">
            {(p) => <TextArea {...p} rows={7} value={message} maxLength={5000} onChange={(e) => setMessage(e.target.value)} />}
          </Field>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="up-foot">
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" icon="send" onClick={send} disabled={busy || to.length === 0 || !subject.trim() || !message.trim()}>
              {busy ? "Sending…" : `Send to ${plural(to.length, "person", "people")}`}
            </Button>
          </div>
        </div>
      ) : error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      {panel?.sent.length ? (
        <section className="em-sent" aria-label="Emails sent for this gallery">
          <h3 className="label">Sent for this gallery</h3>
          <ul>
            {panel.sent.map((m) => (
              <li key={m.id}>
                <Icon name="mail" />
                <span className="nm">
                  <b>{m.to}</b> · {m.kind === "gallery.favorites" ? "Favorites notice" : m.subject}
                  {m.error ? <span className="err"> {m.error}</span> : null}
                </span>
                <span className="when">{timeAgo(m.createdAt)}</span>
                <StatusChip tone={m.status === "sent" ? "ok" : m.status === "failed" ? "bad" : "info"}>{m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Sending"}</StatusChip>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Dialog>
  );
}
