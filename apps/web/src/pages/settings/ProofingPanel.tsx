import { useEffect, useState } from "react";
import { Button, Callout, Panel, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { ProofingControls, type ProofPolicy } from "../../components/ProofingControls.js";

/** The studio's default for how client previews are protected. A gallery can override it. */
export function ProofingPanel({ owner }: { owner: boolean }) {
  const toast = useToast();
  const [saved, setSaved] = useState<ProofPolicy | null>(null);
  const [policy, setPolicy] = useState<ProofPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api<{ policy: ProofPolicy }>("/proofing")
      .then((r) => { setSaved(r.policy); setPolicy(r.policy); })
      .catch((e: Error) => setLoadError(e.message));
  }, []);
  const save = useSubmit(() => api<{ policy: ProofPolicy }>("/proofing", { method: "PUT", body: policy }));

  if (loadError) return <Callout tone="bad" title="Couldn't load protected proofing">{loadError}</Callout>;
  if (!saved || !policy) return <div className="skeleton" style={{ height: 320 }} aria-busy="true" />;
  const dirty = JSON.stringify(policy) !== JSON.stringify(saved);

  return (
    <Panel
      title="Protected proofing"
      description="Client previews are re-drawn on your server at a smaller size with your watermark spread irregularly across each photo, so a saved preview is less useful to copy. Originals are never touched. This is the default for every gallery."
      footer={
        owner ? (
          <div className="form-actions">
            {dirty ? <Button variant="ghost" onClick={() => setPolicy(saved)}>Discard changes</Button> : null}
            <Button variant="primary" loading={save.busy} disabled={!dirty} onClick={async () => {
              const r = await save.submit();
              if (!r) return;
              setSaved(r.policy);
              setPolicy(r.policy);
              toast("Protected proofing saved");
            }}>Save protection</Button>
          </div>
        ) : <span className="hint">Only the studio owner can change this.</span>
      }
    >
      {save.error ? <Callout tone="bad">{save.error}</Callout> : null}
      <ProofingControls value={policy} onChange={(p) => setPolicy({ ...policy, ...p })} disabled={!owner} idPrefix="studio-proof" />
    </Panel>
  );
}
