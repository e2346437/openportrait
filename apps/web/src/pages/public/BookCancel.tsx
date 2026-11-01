import { useState } from "react";
import { useParams } from "react-router";
import { Button, Callout, Spinner } from "@openportrait/ui";
import { publicApi } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { PublicMessage, PublicShell } from "./PublicShell.js";

interface Info {
  name: string;
  status: "pending" | "confirmed" | "declined" | "cancelled";
  when: string;
  past: boolean;
  studioName: string;
}

/** The link in a booking email: shows what it is, and cancels it on request. */
export function BookCancelPage() {
  const { token = "" } = useParams();
  const { data, setData, error, loading } = useLoad<Info>(`/book-cancel/${encodeURIComponent(token)}`, { api: publicApi });
  const [confirming, setConfirming] = useState(false);
  const cancel = useSubmit(() => publicApi<Info>(`/book-cancel/${encodeURIComponent(token)}`, { method: "POST" }));

  if (loading) return <PublicShell narrow><Spinner label="Loading" /></PublicShell>;
  if (error || !data) return <PublicMessage title="We couldn't find that booking">The link may be incomplete. Please contact the studio directly.</PublicMessage>;
  const closed = data.status === "cancelled" || data.status === "declined";
  return (
    <PublicShell studio={data.studioName} narrow>
      <h1 className="pub-title">{closed ? "This booking is cancelled" : "Your booking"}</h1>
      <p className="pub-lead" role="status">
        {data.name}, {data.when}.
      </p>
      {closed ? (
        <p className="muted">Nothing more to do. You're welcome to book another time.</p>
      ) : data.past ? (
        <p className="muted">That time has already passed.</p>
      ) : confirming ? (
        <>
          {cancel.error ? <Callout tone="bad">{cancel.error}</Callout> : null}
          <p>Cancel this booking? The time will be released.</p>
          <div className="form-actions">
            <Button variant="primary" loading={cancel.busy} onClick={async () => { const r = await cancel.submit(); if (r) setData(r); }}>
              Yes, cancel it
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </>
      ) : (
        <Button onClick={() => setConfirming(true)}>Cancel this booking</Button>
      )}
    </PublicShell>
  );
}
