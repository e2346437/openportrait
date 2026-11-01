import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button, Callout, Spinner } from "@openportrait/ui";
import { AccessPicker } from "../components/AccessPicker.js";
import { api, type AiLevel } from "../lib/api.js";
import { useSession } from "../lib/session.js";
import { AuthLayout } from "./AuthLayout.js";

/** Where Claude, ChatGPT and other OAuth clients send the owner to approve a connection. */
export function ConsentAIPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useSession();
  const [client, setClient] = useState<{ clientName: string; redirectHost: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<AiLevel>("read");
  const [areas, setAreas] = useState<string[]>(["studio"]);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const owner = me?.user?.role === "owner";
  const query = new URLSearchParams({ client_id: params.get("client_id") ?? "", redirect_uri: params.get("redirect_uri") ?? "" });

  useEffect(() => {
    if (!owner) return;
    api<{ clientName: string; redirectHost: string }>(`/oauth/request?${query}`).then(setClient, (e) => setError(e instanceof Error ? e.message : "This sign-in link isn't valid."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny");
    try {
      const res = await api<{ redirectTo: string }>("/oauth/decision", {
        method: "POST",
        body: { client_id: params.get("client_id"), redirect_uri: params.get("redirect_uri"), code_challenge: params.get("code_challenge"), state: params.get("state") ?? undefined, approve, level, areas },
      });
      window.location.assign(res.redirectTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Start again from your AI app.");
      setBusy(null);
    }
  };

  return (
    <AuthLayout headline="Connect your AI" body="You stay in control. Anything that reaches a client or touches money waits for your approval.">
      {!owner ? (
        <Callout tone="warn" title="Only the studio owner can do this">
          Ask the owner to sign in and approve the connection.
        </Callout>
      ) : error && !client ? (
        <Callout tone="bad" title="This sign-in link isn't valid" action={<Button size="sm" onClick={() => navigate("/studio/settings/ai")}>Back to settings</Button>}>
          {error}
        </Callout>
      ) : !client ? (
        <Spinner label="Checking the request" />
      ) : (
        <div className="consent">
          <div>
            <h2>
              Let <b>{client.clientName}</b> use your studio?
            </h2>
            <p className="hint">
              It will return to <span className="mono">{client.redirectHost}</span> after you approve. Only continue if you started this from your AI app.
            </p>
          </div>
          <AccessPicker level={level} onLevel={setLevel} areas={areas} onAreas={setAreas} allAreas={["studio", "contacts", "leads", "shoots", "calendar", "quotes", "orders", "galleries", "email"]} />
          {error ? <Callout tone="bad">{error}</Callout> : null}
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <Button variant="primary" loading={busy === "approve"} disabled={busy !== null || areas.length === 0} onClick={() => decide(true)}>
              Approve
            </Button>
            <Button variant="ghost" loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)}>
              Cancel
            </Button>
          </div>
          <p className="hint">You can disconnect it any time in Settings → Connect your AI.</p>
        </div>
      )}
    </AuthLayout>
  );
}
