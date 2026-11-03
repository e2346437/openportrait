import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Callout, Dialog, Panel, Spinner, useToast } from "@openportrait/ui";
import { api, ApiError } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";
import { formatBytes } from "../../lib/tether.js";
import { formatDate, plural } from "../../lib/galleries.js";

export interface RestorePlan {
  source: string;
  kind: "zip" | "db";
  createdAt: string | null;
  includesGalleries: boolean;
  includesOriginals: boolean;
  files: number;
  fileBytes: number;
  counts: { contacts: number; shoots: number; orders: number };
  stagedAt: string;
  phase: "staged" | "confirmed" | "files";
  withFiles: boolean;
  safetyBackup: string | null;
}
interface RestoreResult {
  at: string;
  ok: boolean;
  from: string;
  message: string;
  filesRestored: number;
  filesSkipped: number;
  filesFailed: number;
  safetyBackup: string | null;
  problems: string[];
}
interface RestoreState {
  plan: RestorePlan | null;
  result: RestoreResult | null;
  copying: { done: number; total: number } | null;
  busy: boolean;
}

/** Sends a file to the server as the raw request body so a multi-gigabyte archive never has to fit in memory. */
function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<RestorePlan> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/studio/backups/restore/upload");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted. Check your connection and try again."));
    xhr.onload = () => {
      let body: { plan?: RestorePlan; message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.plan) resolve(body.plan);
      else reject(new ApiError(xhr.status, body.message ?? `The upload failed (${xhr.status}).`));
    };
    xhr.send(file);
  });
}

/** Everything the Backups page needs to run a restore: the state from the server and the steps that change it. */
export function useRestore() {
  const toast = useToast();
  const state = useLoad<RestoreState>("/backups/restore");
  const [busy, setBusy] = useState<null | { label: string; progress?: number }>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const reload = state.reload;

  const copying = state.data?.copying;
  useEffect(() => {
    if (!copying) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [copying, reload]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy({ label });
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return {
    state: state.data,
    loadError: state.error,
    busy,
    error,
    restarting,
    clearError: () => setError(null),
    fromBackup: (name: string) => run("Checking this backup…", () => api("/backups/restore/from-backup", { method: "POST", body: { name } })),
    fromFile: (file: File) =>
      run("Uploading…", async () => {
        setBusy({ label: "Uploading…", progress: 0 });
        await uploadFile(file, (p) => setBusy({ label: p >= 1 ? "Checking the backup…" : "Uploading…", progress: p }));
      }),
    cancel: () => run("Cancelling…", () => api("/backups/restore", { method: "DELETE" })),
    dismissResult: () => run("", () => api("/backups/restore/result", { method: "DELETE" })),
    confirmAndRestart: (withFiles: boolean) =>
      run("Saving a safety copy of your current data…", async () => {
        await api("/backups/restore/confirm", { method: "POST", body: { confirm: true, withFiles } });
        await api("/backups/restore/restart", { method: "POST", body: {} });
        setRestarting(true);
        toast("Restarting to finish the restore");
      }),
  };
}
export type Restore = ReturnType<typeof useRestore>;

/** After asking for a restart, wait for the server to go away and come back, then reload the page. */
function RestartingScreen() {
  const [slow, setSlow] = useState(false);
  const wentDown = useRef(false);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok && (wentDown.current || Date.now() - started > 12_000)) window.location.reload();
      } catch {
        wentDown.current = true;
      }
      if (Date.now() - started > 90_000) setSlow(true);
    }, 1500);
    return () => clearInterval(t);
  }, []);
  return (
    <Panel title="Restarting OpenPortrait">
      <Spinner label="Restoring your studio" />
      <p className="hint" role="status">
        Your data is being swapped in as OpenPortrait starts. This page reloads on its own, usually within a minute.
      </p>
      {slow ? (
        <Callout tone="warn" title="This is taking longer than usual">
          If OpenPortrait doesn't come back, restart the container from Unraid or Docker. The restore finishes as soon as it starts.
        </Callout>
      ) : null}
    </Panel>
  );
}

/** What the last restore did, shown once until it's dismissed. */
function ResultBanner({ r, onDismiss }: { r: RestoreResult; onDismiss: () => void }) {
  const tone = r.ok ? "ok" : r.filesFailed || r.filesRestored || r.message.includes("restored") ? "warn" : "bad";
  return (
    <Callout
      tone={tone}
      title={r.ok ? "Restore finished" : tone === "bad" ? "The restore didn't go ahead" : "Restore finished with a problem"}
      action={
        <Button size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <p>{r.message}</p>
      {r.filesRestored || r.filesSkipped || r.filesFailed ? (
        <p>
          {plural(r.filesRestored, "photo")} copied back
          {r.filesSkipped ? `, ${plural(r.filesSkipped, "photo")} already there and left alone` : ""}
          {r.filesFailed ? `, ${plural(r.filesFailed, "photo")} that could not be copied` : ""}.
        </p>
      ) : null}
      {r.problems.length ? <p className="hint">{r.problems.join(" · ")}</p> : null}
      {r.safetyBackup ? <p className="hint">The data you had before is saved as {r.safetyBackup} in your backups list, in case you need to go back.</p> : null}
      {r.ok ? <p className="hint">If you are asked to sign in again, that's expected: sign-ins come back from the backup.</p> : null}
    </Callout>
  );
}

/** The restore section of Settings > Backups: pick a file, review, confirm. */
export function RestorePanel({ restore }: { restore: Restore }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [withFiles, setWithFiles] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const plan = restore.state?.plan ?? null;
  const reviewing = plan?.phase === "staged";
  const closeReview = useCallback(() => {
    if (!restore.busy) void restore.cancel();
  }, [restore]);

  useEffect(() => {
    if (plan) {
      setWithFiles(plan.files > 0);
      setUnderstood(false);
    }
  }, [plan?.source, plan?.stagedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (restore.restarting) return <RestartingScreen />;
  const busy = restore.busy;

  return (
    <>
      {restore.state?.result ? <ResultBanner r={restore.state.result} onDismiss={() => void restore.dismissResult()} /> : null}
      {restore.state?.copying ? (
        <Callout tone="info" title="Copying photos back">
          {restore.state.copying.done.toLocaleString()} of {plural(restore.state.copying.total, "photo")} so far. You can keep using OpenPortrait while this finishes.
        </Callout>
      ) : null}
      {plan && plan.phase !== "staged" && !restore.state?.copying ? (
        <Callout tone="info" title="A restore is waiting to finish">
          It is applied when OpenPortrait next starts.
        </Callout>
      ) : null}

      <Panel
        title="Restore from a backup"
        description="Bring your studio back from a backup on this server (choose Restore beside it in the list above) or from a file you saved elsewhere."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.db,application/zip,application/octet-stream"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void restore.fromFile(f);
              }}
            />
            <Button icon="download" disabled={!!busy || !!plan} onClick={() => fileInput.current?.click()}>
              Choose a backup file
            </Button>
          </>
        }
      >
        {busy ? (
          <div className="restore-busy" role="status" aria-live="polite">
            <Spinner label={busy.label} />
            {busy.progress !== undefined ? (
              <div className="restore-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(busy.progress * 100)}%` }} />
              </div>
            ) : null}
            <span className="hint">{busy.label}</span>
          </div>
        ) : null}
        {restore.error && !reviewing ? (
          <Callout tone="bad" title="This backup can't be restored">
            {restore.error}
          </Callout>
        ) : null}
        {!busy && !restore.error && !reviewing ? (
          <p className="hint">
            Restoring replaces your clients, shoots, invoices and settings with what the backup holds. OpenPortrait saves a copy of your current data first and restarts once to apply it.
            Photos already in your galleries are never deleted or overwritten.
          </p>
        ) : null}
        {restore.loadError ? <p className="hint backup-error">{restore.loadError}</p> : null}
      </Panel>

      <Dialog
        open={reviewing}
        onClose={closeReview}
        wide
        title="Restore this backup?"
        description={plan ? `${plan.source}${plan.createdAt ? ` · made ${formatDate(Date.parse(plan.createdAt), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={closeReview} disabled={!!busy}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!understood || !!busy} loading={!!busy} onClick={() => void restore.confirmAndRestart(withFiles)}>
              Restore and restart
            </Button>
          </>
        }
      >
        {plan ? (
          <>
            <dl className="restore-facts">
              <div>
                <dt>Clients</dt>
                <dd>{plan.counts.contacts.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Shoots</dt>
                <dd>{plan.counts.shoots.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Orders</dt>
                <dd>{plan.counts.orders.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Photos in the backup</dt>
                <dd>{plan.files ? `${plural(plan.files, "file")} · ${formatBytes(plan.fileBytes)}` : "None"}</dd>
              </div>
            </dl>
            {plan.kind === "db" ? <p className="hint">This is an older database-only copy, so it holds no photos.</p> : null}
            <Callout tone="warn" title="Anything added since this backup will be replaced">
              Clients, shoots, invoices and settings changed after the backup was made go back to how they were. A copy of your current data is saved first, so you can undo this.
            </Callout>
            {plan.files > 0 ? (
              <label className="restore-check">
                <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
                <span>
                  <b>Also copy the photos back</b>
                  <small>Only photos that are missing are added. Existing photos are left exactly as they are.</small>
                </span>
              </label>
            ) : null}
            <label className="restore-check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>
                <b>I understand OpenPortrait will restart</b>
                <small>Everyone is signed out for a moment. Passwords for email, PayPal and Google need your secret key, which a backup never holds.</small>
              </span>
            </label>
            {restore.error ? (
              <Callout tone="bad" title="The restore didn't start">
                {restore.error}
              </Callout>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </>
  );
}
