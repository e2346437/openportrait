import { useEffect, useState, type FormEvent } from "react";
import { Button, Callout, Field, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";

interface PayPalState {
  clientId: string;
  hasSecret: boolean;
  mode: "sandbox" | "live";
  webhookId: string;
  webhookUrl: string;
  hasPublicUrl: boolean;
  configured: boolean;
}

/** Lets clients pay invoices online. PayPal first; the money lands in the studio's own PayPal account. */
export function PaymentsSettingsPage() {
  const toast = useToast();
  const { data, error, reload } = useLoad<PayPalState>("/payments/paypal");
  const [f, setF] = useState({ clientId: "", clientSecret: "", mode: "sandbox", webhookId: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => {
    if (data) setF({ clientId: data.clientId, clientSecret: "", mode: data.mode, webhookId: data.webhookId });
  }, [data?.clientId, data?.mode, data?.webhookId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useSubmit(() => api("/payments/paypal", { method: "PUT", body: { ...f, ...(f.clientSecret ? {} : { clientSecret: undefined }) } }));
  const test = useSubmit(() => api<{ ok: boolean }>("/payments/paypal/test", { method: "POST" }));

  if (error && !data) return <Callout tone="bad" title="Couldn't load payment settings">{error}</Callout>;
  if (!data) return <Spinner label="Loading" />;

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.submit()) === undefined) return;
    toast("Saved");
    reload();
  };
  const onTest = async () => {
    const r = await test.submit();
    if (r) toast("PayPal accepted these details");
  };
  const ready = data.configured && data.hasPublicUrl;

  return (
    <div className="stack">
      <Panel
        title="PayPal"
        description="Clients pay an invoice by card or PayPal and the money goes straight to your PayPal account. OpenPortrait marks the invoice paid for you."
        actions={<StatusChip tone={ready ? "ok" : "warn"}>{ready ? (data.mode === "live" ? "Live" : "Testing") : "Not set up"}</StatusChip>}
      >
        {!data.hasPublicUrl ? (
          <Callout tone="warn" title="Set up your internet address first">
            PayPal sends clients back to your studio after they pay, so OpenPortrait needs its public address. Add it under Internet, then come back.
          </Callout>
        ) : null}
        <form onSubmit={onSave} noValidate className="form-grid">
          {save.error ? <div className="span-2"><Callout tone="bad">{save.error}</Callout></div> : null}
          <Field label="Mode" hint="Start in Testing with a sandbox app. Nothing real is charged." className="span-2">
            {(p) => (
              <select {...p} className="input" value={f.mode} onChange={set("mode")}>
                <option value="sandbox">Testing (sandbox)</option>
                <option value="live">Live (real money)</option>
              </select>
            )}
          </Field>
          <Field label="Client ID">{(p) => <TextInput {...p} value={f.clientId} onChange={set("clientId")} autoComplete="off" spellCheck={false} />}</Field>
          <Field label="Secret" hint={data.hasSecret ? "Saved. Leave blank to keep it." : undefined}>
            {(p) => <TextInput {...p} type="password" value={f.clientSecret} onChange={set("clientSecret")} autoComplete="new-password" placeholder={data.hasSecret ? "••••••••" : ""} />}
          </Field>
          <Field className="span-2" label="Webhook ID" hint="Optional but recommended. It lets OpenPortrait record a payment even if the client closes the page.">
            {(p) => <TextInput {...p} value={f.webhookId} onChange={set("webhookId")} autoComplete="off" spellCheck={false} />}
          </Field>
          <div className="span-2 form-actions">
            <Button variant="primary" type="submit" loading={save.busy}>Save</Button>
            <Button type="button" disabled={!data.hasSecret || !data.clientId} loading={test.busy} onClick={onTest}>Check these details</Button>
          </div>
          {test.error ? <div className="span-2"><Callout tone="bad" title="PayPal didn't accept those details">{test.error}</Callout></div> : null}
        </form>
      </Panel>

      <Panel title="How to connect PayPal" description="About five minutes. You need a PayPal Business account.">
        <ol className="plain-steps">
          <li>Open developer.paypal.com, sign in, and go to Apps &amp; Credentials.</li>
          <li>Choose Sandbox to test or Live to take real payments, then Create App. Name it after your studio.</li>
          <li>Copy the Client ID and Secret into the form above, pick the matching mode, and save.</li>
          <li>
            In the same app, add a webhook. Use this address: <code>{data.webhookUrl || "(set your internet address first)"}</code>
          </li>
          <li>Tick Checkout order approved, Payment capture completed and Payment capture refunded. Save, then copy the Webhook ID here.</li>
          <li>Press “Check these details”. Test with a sandbox buyer account before switching to Live.</li>
        </ol>
      </Panel>
    </div>
  );
}
