import { useState, type FormEvent } from "react";
import { Button, Callout, Field, Spinner, TextArea, TextInput } from "@openportrait/ui";
import { publicApi } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { PublicMessage, PublicShell } from "./PublicShell.js";
import { RichText } from "../../components/RichText.js";

interface Info {
  enabled: boolean;
  studioName: string;
  intro: string;
  thanks: string;
  shootTypes: Array<{ id: string; name: string }>;
}

/** The inquiry form clients fill in. Also embeddable with ?embed=1. */
export function InquirePage() {
  const { data, error, loading } = useLoad<Info>("/inquiry", { api: publicApi });
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", shootTypeId: "", eventDate: "", message: "", website: "" });
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { busy, error: err, fieldErrors, submit } = useSubmit(() => publicApi("/inquiry", { body: { ...f, shootTypeId: f.shootTypeId || undefined, eventDate: f.eventDate || undefined } }));

  if (loading) return <PublicShell narrow><Spinner label="Loading" /></PublicShell>;
  if (error || !data) return <PublicMessage title="This page isn't available">Please try again in a little while.</PublicMessage>;
  if (!data.enabled) return <PublicMessage title="Not taking inquiries right now">{data.studioName ? `${data.studioName} isn't accepting new inquiries through this page at the moment.` : "Please check back later."}</PublicMessage>;
  if (done)
    return (
      <PublicShell studio={data.studioName} narrow>
        <h1 className="pub-title">Thank you</h1>
        <div role="status">
          <RichText className="pub-lead" text={data.thanks} />
        </div>
      </PublicShell>
    );

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if ((await submit()) !== undefined) setDone(true);
  };

  return (
    <PublicShell studio={data.studioName} narrow>
      <h1 className="pub-title">Get in touch</h1>
      <RichText className="pub-lead" text={data.intro} />
      <form onSubmit={go} noValidate className="form-grid pub-form">
        {err ? (
          <div className="span-2">
            <Callout tone="bad">{err}</Callout>
          </div>
        ) : null}
        <Field label="First name" error={fieldErrors.firstName}>
          {(p) => <TextInput {...p} autoComplete="given-name" required value={f.firstName} onChange={set("firstName")} />}
        </Field>
        <Field label="Last name">
          {(p) => <TextInput {...p} autoComplete="family-name" value={f.lastName} onChange={set("lastName")} />}
        </Field>
        <Field className="span-2" label="Email" error={fieldErrors.email} hint="Where I'll reply.">
          {(p) => <TextInput {...p} type="email" autoComplete="email" required value={f.email} onChange={set("email")} />}
        </Field>
        <Field label="Phone" hint="Optional.">
          {(p) => <TextInput {...p} type="tel" autoComplete="tel" value={f.phone} onChange={set("phone")} />}
        </Field>
        <Field label="Date, if you have one" hint="Optional." error={fieldErrors.eventDate}>
          {(p) => <TextInput {...p} type="date" value={f.eventDate} onChange={set("eventDate")} />}
        </Field>
        {data.shootTypes.length ? (
          <Field className="span-2" label="What are you looking for?">
            {(p) => (
              <select {...p} className="input" value={f.shootTypeId} onChange={set("shootTypeId")}>
                <option value="">Choose one (optional)</option>
                {data.shootTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field className="span-2" label="Tell me about it" hint="The more you share, the better I can help.">
          {(p) => <TextArea {...p} rows={5} maxLength={5000} value={f.message} onChange={set("message")} />}
        </Field>
        {/* Real visitors never see this. Bots tend to fill every field. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
          <label>
            Website
            <input type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
          </label>
        </div>
        <div className="span-2">
          <Button variant="primary" type="submit" size="lg" loading={busy} block>
            Send
          </Button>
        </div>
      </form>
    </PublicShell>
  );
}
