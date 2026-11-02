import { useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSession } from "../../lib/session.js";
import { useSubmit } from "../../lib/useForm.js";
import { TwoStepPanel } from "./TwoStep.js";

export function AccountSettingsPage() {
  const { me } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== next;
  const { busy, error, fieldErrors, submit } = useSubmit(() => api("/auth/password", { body: { current, next } }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    if ((await submit()) === undefined) return;
    setCurrent("");
    setNext("");
    setConfirm("");
    toast("Password changed. Other devices were signed out.");
  };

  return (
    <>
      <Panel title="Profile">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{me?.user?.name}</dd>
          <dt>Email</dt>
          <dd>{me?.user?.email}</dd>
          <dt>Role</dt>
          <dd>{me?.user?.role === "owner" ? "Studio owner" : me?.user?.role}</dd>
        </dl>
      </Panel>
      <form onSubmit={onSubmit} noValidate>
        <Panel
          title="Change password"
          description="Changing it signs you out everywhere else."
          footer={
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < 10 || mismatch}>
                Change password
              </Button>
            </div>
          }
        >
          {error ? <Callout tone="bad">{error}</Callout> : null}
          <div className="form-grid">
            <Field className="span-2" label="Current password" error={fieldErrors.current}>
              {(p) => <TextInput {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
            </Field>
            <Field label="New password" error={fieldErrors.next} hint="At least 10 characters.">
              {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
            </Field>
            <Field label="Confirm new password" error={mismatch ? "These don't match yet." : null}>
              {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
            </Field>
          </div>
        </Panel>
      </form>
      <TwoStepPanel />
    </>
  );
}
