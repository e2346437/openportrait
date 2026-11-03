import { Link } from "react-router";
import { Callout } from "@openportrait/ui";
import { useLoad } from "../lib/useLoad.js";
import { useSession } from "../lib/session.js";

/**
 * Shown where something depends on email going out. Says plainly that email is off and what that changes here.
 * Only the owner can read the email settings, so everyone else sees nothing rather than a wrong answer.
 */
export function EmailOffCallout({ children }: { children: string }) {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const { data } = useLoad<{ configured: boolean }>(owner ? "/email" : null);
  if (!data || data.configured) return null;
  return (
    <Callout tone="warn" title="Email isn't set up" action={<Link className="btn sm" to="/studio/settings/email">Set up email</Link>}>
      {children}
    </Callout>
  );
}
