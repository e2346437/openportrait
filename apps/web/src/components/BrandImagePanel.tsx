import { useEffect, useRef, useState } from "react";
import { Button, Panel, useToast } from "@openportrait/ui";
import { api } from "../lib/api.js";

interface Branding {
  logo: string | null;
  signInPhoto: string | null;
}

/** One studio image (the logo, the sign-in photo): preview, upload, remove. Owners change it; everyone else sees it. */
export function BrandImagePanel({
  kind,
  owner,
  title,
  description,
  alt,
  wide,
}: {
  kind: "logo" | "sign-in";
  owner: boolean;
  title: string;
  description: string;
  alt: string;
  wide?: boolean;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const field = kind === "logo" ? "logo" : "signInPhoto";
  const noun = kind === "logo" ? "logo" : "photo";

  useEffect(() => {
    api<Branding>("/branding")
      .then((r) => setSrc(r[field]))
      .catch(() => setSrc(null));
  }, [field]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/studio/branding/${kind}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": file.type },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as Partial<Branding> & {
        message?: string;
      };
      if (!res.ok)
        throw new Error(
          data.message ??
            "That file couldn't be used. Try a PNG, JPEG or WebP image under 5 MB.",
        );
      setSrc(data[field] ?? null);
      toast(`${kind === "logo" ? "Logo" : "Photo"} saved`);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <Panel title={title} description={description}>
      <div className="logo-row">
        <div
          className={`logo-preview${wide ? " wide" : ""}`}
          aria-busy={src === undefined}
        >
          {src ? (
            <img src={src} alt={alt} />
          ) : (
            <span className="muted">No {noun} yet</span>
          )}
        </div>
        {owner ? (
          <div className="logo-acts">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <Button
              icon="plus"
              loading={busy}
              onClick={() => input.current?.click()}
            >
              {src ? `Replace ${noun}` : `Upload ${noun}`}
            </Button>
            {src ? (
              <Button
                variant="ghost"
                onClick={async () => {
                  await api(`/branding/${kind}`, { method: "DELETE" });
                  setSrc(null);
                  toast(`${kind === "logo" ? "Logo" : "Photo"} removed`);
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ) : (
          <span className="hint">Only the studio owner can change this.</span>
        )}
      </div>
    </Panel>
  );
}
