import { useState } from "react";
import { Icon } from "@openportrait/ui";
import { useSession } from "../lib/session.js";
import { useLoad } from "../lib/useLoad.js";

/** Where the Pro add-on is described. */
export const ADDON_URL = "https://openportrait.app/pricing";

export type AddOnFeature = "quickbooks" | "microsoft365" | "bucket-storage" | "second-shooter";

const COPY: Record<AddOnFeature, { title: string; text: string }> = {
  quickbooks: { title: "QuickBooks Online", text: "Send invoices and payments to QuickBooks Online." },
  microsoft365: { title: "Microsoft 365 calendar and email", text: "Sync your Outlook calendar and send studio email through Microsoft 365." },
  "bucket-storage": { title: "Bucket storage (S3 and B2)", text: "Copy backups and originals to S3-compatible or Backblaze B2 storage." },
  "second-shooter": { title: "Second shooters", text: "Assign more than one photographer to a shoot." },
};

const key = (f: AddOnFeature) => `op.addon-prompt.${f}`;
const wasDismissed = (f: AddOnFeature) => {
  try {
    return window.localStorage.getItem(key(f)) === "1";
  } catch {
    return false;
  }
};

/**
 * A quiet one-line pointer to a feature the Pro add-on provides. It shows only to the owner, only
 * while the add-on isn't installed, only where the feature would appear, and can be dismissed for good.
 */
export function AddOnPrompt({ feature }: { feature: AddOnFeature }) {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const { data } = useLoad<{ extensions: Array<{ id: string; status: string }> }>(owner ? "/extensions" : null);
  const [hidden, setHidden] = useState(() => wasDismissed(feature));
  // Wait for the answer so the prompt never flashes up for someone who has the add-on.
  if (!owner || !data || hidden || data.extensions.some((e) => e.id === "pro" && e.status === "loaded")) return null;
  const c = COPY[feature];
  const dismiss = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(key(feature), "1");
    } catch {
      /* the prompt just comes back next visit */
    }
  };
  return (
    <aside className="addon-prompt" aria-label={`${c.title}: provided by the Pro add-on`}>
      <Icon name="sparkle" aria-hidden="true" />
      <p>
        <b>{c.title}</b> is provided by the Pro add-on. {c.text}{" "}
        <a href={ADDON_URL} target="_blank" rel="noreferrer">
          Learn more<span className="sr-only"> about the Pro add-on (opens in a new tab)</span>
        </a>
      </p>
      <button type="button" className="addon-prompt-x" onClick={dismiss} aria-label={`Hide the ${c.title} note`}>
        <Icon name="x" aria-hidden="true" />
      </button>
    </aside>
  );
}
