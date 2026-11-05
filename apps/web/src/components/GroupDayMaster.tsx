import { useEffect, useState } from "react";
import { Button, Callout, Field, Panel, StatusChip, Switch, TextInput, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";

interface Master {
  enabled: boolean;
  link?: string | null;
  hasPassword?: boolean;
  expiresAt?: number | null;
  expired?: boolean;
  views?: number;
  lastViewedAt?: number | null;
}

const dayInput = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

/** The organisation's private page: previews of everyone who is on it, never downloads. */
export function GroupDayMaster({ shootId }: { shootId: string }) {
  const toast = useToast();
  const [m, setM] = useState<Master | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [ends, setEnds] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (next: Master) => {
    setM(next);
    setEnds(dayInput(next.expiresAt));
  };
  useEffect(() => {
    api<Master>(`/shoots/${shootId}/master`).then(apply, (e) => setError(e instanceof Error ? e.message : "Couldn't load this."));
  }, [shootId]);

  const save = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    setError("");
    try {
      apply(await api<Master>(`/shoots/${shootId}/master`, { method: "PUT", body }));
      if (done) toast(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!m?.link) return;
    try {
      await navigator.clipboard.writeText(m.link);
      toast("Link copied");
    } catch {
      toast("Select the link and copy it", "bad");
    }
  };

  if (!m) return error ? <Callout tone="bad">{error}</Callout> : null;
  return (
    <Panel
      title="Organisation's page"
      description="One private page where the organisation can see previews of everyone you've chosen to include. Previews stay watermarked until you unlock galleries. People are listed by name only."
      actions={m.enabled ? <StatusChip tone={m.expired ? "bad" : "ok"}>{m.expired ? "Expired" : "On"}</StatusChip> : <StatusChip tone="neutral">Off</StatusChip>}
    >
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <Switch label="Share this page" checked={m.enabled} disabled={busy} onChange={(v) => void save({ enabled: v })} />
      {m.enabled && m.link ? (
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="span-2">
            <Field label="Link">{(p) => <TextInput {...p} readOnly value={m.link ?? ""} onFocus={(e) => e.currentTarget.select()} />}</Field>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <Button size="sm" icon="copy" onClick={() => void copy()}>
                Copy link
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save({ rotate: true }, "New link made. The old one no longer works.")}>
                Make a new link
              </Button>
            </div>
          </div>
          <Field label={m.hasPassword ? "Change password" : "Password"} hint={m.hasPassword ? "A password is set. Changing it signs everyone out." : "Optional. At least 6 characters."}>
            {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Ends on" hint="Optional. The link stops working after this day.">
            {(p) => <TextInput {...p} type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />}
          </Field>
          <div className="form-actions span-2">
            {m.hasPassword ? (
              <Button disabled={busy} onClick={() => void save({ password: null }, "Password removed")}>
                Remove password
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                const body: Record<string, unknown> = { expiresAt: ends ? new Date(`${ends}T23:59:59`).getTime() : null };
                if (password) body.password = password;
                void save(body, "Saved").then(() => setPassword(""));
              }}
            >
              Save
            </Button>
          </div>
          <p className="hint span-2">
            {m.views ? `Opened ${m.views} time${m.views === 1 ? "" : "s"}${m.lastViewedAt ? `, last ${new Date(m.lastViewedAt).toLocaleString()}` : ""}.` : "Not opened yet."}
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
