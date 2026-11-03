import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  Field,
  Panel,
  Spinner,
  StatusChip,
  TextInput,
  useToast,
} from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { useLoad } from "../../lib/useLoad.js";
import { useSubmit } from "../../lib/useForm.js";
import { formatBytes } from "../../lib/tether.js";
import { formatDate, plural, timeAgo } from "../../lib/galleries.js";
import { SwitchRow } from "../../components/SwitchRow.js";
import { BackupDestinationsPanel } from "./BackupDestinations.js";
import { RestorePanel, useRestore } from "./BackupRestore.js";

interface Config {
  enabled: boolean;
  everyHours: number;
  keep: number;
  includeGalleries: boolean;
  includeOriginals: boolean;
}
interface BackupFile {
  name: string;
  size: number;
  createdAt: number;
  kind: "scheduled" | "manual" | "legacy";
  includesGalleries: boolean;
  includesOriginals: boolean;
  files: number;
}
interface Overview {
  config: Config;
  files: BackupFile[];
  status: { running: boolean; lastAt: number | null; lastError: string | null };
  everyHoursChoices: number[];
}
interface Sizes {
  galleries: { files: number; bytes: number };
  originals: { files: number; bytes: number };
}

const EVERY: Record<number, string> = {
  6: "Every 6 hours",
  12: "Every 12 hours",
  24: "Every day",
  72: "Every 3 days",
  168: "Every week",
};

/** Settings > Backups: when the studio backs itself up, what goes in, and the backups you can download. */
export function BackupsSettingsPage() {
  const toast = useToast();
  const overview = useLoad<Overview>("/backups");
  const sizes = useLoad<Sizes>("/backups/sizes");
  const [form, setForm] = useState<Config | null>(null);
  const [keepText, setKeepText] = useState("");
  const restore = useRestore();
  const [starting, setStarting] = useState(false);
  const data = overview.data;
  const running = !!data?.status.running || starting;

  useEffect(() => {
    if (data && !form) {
      setForm(data.config);
      setKeepText(String(data.config.keep));
    }
  }, [data, form]);

  // While a backup runs, check back every couple of seconds so the new file appears on its own.
  const reload = overview.reload;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [running, reload]);
  useEffect(() => {
    if (starting && data && !data.status.running) setStarting(false);
  }, [starting, data]);

  const keep = Number(keepText);
  const keepValid = Number.isInteger(keep) && keep >= 1 && keep <= 90;
  const dirty =
    !!form &&
    !!data &&
    (form.enabled !== data.config.enabled ||
      form.everyHours !== data.config.everyHours ||
      form.includeGalleries !== data.config.includeGalleries ||
      form.includeOriginals !== data.config.includeOriginals ||
      keep !== data.config.keep);

  const save = useSubmit(async () => {
    if (!form) return;
    await api("/backups/config", { method: "PUT", body: { ...form, keep } });
    toast("Backup settings saved");
    overview.reload();
  });

  const runNow = async () => {
    setStarting(true);
    try {
      await api("/backups/run", { method: "POST", body: {} });
      toast("Backup started");
      setTimeout(overview.reload, 800);
    } catch (e) {
      setStarting(false);
      toast((e as Error).message, "bad");
    }
  };

  const remove = async (f: BackupFile) => {
    if (
      !window.confirm(
        `Delete the backup from ${formatDate(f.createdAt)}? This can't be undone.`,
      )
    )
      return;
    try {
      await api(`/backups/files/${encodeURIComponent(f.name)}`, {
        method: "DELETE",
      });
      toast("Backup deleted");
      overview.reload();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  if (overview.error)
    return (
      <Callout tone="bad" title="Couldn't load backups">
        {overview.error}
      </Callout>
    );
  if (!data || !form) return <Spinner label="Loading backups" />;

  const sz = sizes.data;
  const sizeHint = (b?: { files: number; bytes: number }) =>
    b
      ? `${plural(b.files, "file")}, ${formatBytes(b.bytes)} right now`
      : "Measuring…";

  return (
    <div className="stack">
      <Panel
        title="Automatic backups"
        description="OpenPortrait saves a copy of your studio's database on a schedule, so a failed disk or a mistake never costs you your clients, shoots and invoices."
        footer={
          <div className="panel-foot-row">
            {save.error ? (
              <span className="hint backup-error" role="alert">
                {save.error}
              </span>
            ) : (
              <span className="hint">
                {dirty ? "You have unsaved changes." : "Saved."}
              </span>
            )}
            <Button
              variant="primary"
              disabled={!dirty || !keepValid}
              loading={save.busy}
              onClick={() => void save.submit()}
            >
              Save changes
            </Button>
          </div>
        }
      >
        <SwitchRow
          checked={form.enabled}
          onChange={(v) => setForm({ ...form, enabled: v })}
          label="Back up automatically"
          hint="Turn this off only if you back up /config another way."
        />
        <div className="form-grid">
          <Field label="How often">
            {(a) => (
              <select
                {...a}
                className="input"
                value={form.everyHours}
                disabled={!form.enabled}
                onChange={(e) =>
                  setForm({ ...form, everyHours: Number(e.target.value) })
                }
              >
                {data.everyHoursChoices.map((h) => (
                  <option key={h} value={h}>
                    {EVERY[h] ?? `Every ${h} hours`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Automatic backups to keep"
            hint="The oldest are removed first. Backups you start yourself are never removed for you."
            error={keepValid ? undefined : "Enter a number from 1 to 90."}
          >
            {(a) => (
              <TextInput
                {...a}
                type="number"
                inputMode="numeric"
                min={1}
                max={90}
                value={keepText}
                onChange={(e) => setKeepText(e.target.value)}
              />
            )}
          </Field>
        </div>
        <fieldset className="backup-include">
          <legend>What goes in each backup</legend>
          <SwitchRow
            checked
            disabled
            label="Database"
            hint="Clients, shoots, invoices, contracts and settings. Always included, and small."
            onChange={() => undefined}
          />
          <SwitchRow
            checked={form.includeGalleries}
            onChange={(v) => setForm({ ...form, includeGalleries: v })}
            label="Gallery photos"
            hint={sizeHint(sz?.galleries)}
          />
          <SwitchRow
            checked={form.includeOriginals}
            onChange={(v) => setForm({ ...form, includeOriginals: v })}
            label="Originals and RAW files"
            hint={sizeHint(sz?.originals)}
          />
        </fieldset>
        {form.includeGalleries || form.includeOriginals ? (
          <Callout tone="warn" title="Photo backups use a lot of disk space">
            Every kept backup holds its own full copy of the photos you include.
            If your photos are already protected by a RAID array or a backup of
            your galleries share, leave these off and keep the database backups
            small.
          </Callout>
        ) : null}
        <Callout tone="info" title="Your secret key isn't in the backup">
          Passwords for email, PayPal and Google are encrypted with a key stored
          in <code>secret.key</code> in your config folder. It is left out of
          backups on purpose, so keep a separate copy somewhere safe. Without it
          you would have to enter those passwords again after a restore.
        </Callout>
      </Panel>

      <BackupDestinationsPanel />

      <Panel
        title="Your backups"
        description={
          data.status.lastAt
            ? `Last backup ${timeAgo(data.status.lastAt)}.`
            : "No backup has run yet."
        }
        actions={
          <Button
            icon="refresh"
            loading={running}
            onClick={() => void runNow()}
          >
            {running ? "Backing up…" : "Back up now"}
          </Button>
        }
      >
        {data.status.lastError ? (
          <Callout tone="bad" title="The last backup didn't finish">
            {data.status.lastError}
          </Callout>
        ) : null}
        {data.files.length === 0 ? (
          <EmptyState icon="inbox" title="No backups yet">
            Your first automatic backup runs within the hour. To make one right
            now, choose “Back up now”.
          </EmptyState>
        ) : (
          <ul className="backup-list">
            {data.files.map((f) => (
              <li key={f.name} className="backup-row">
                <div className="backup-main">
                  <b>
                    {formatDate(f.createdAt, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </b>
                  <span className="hint">
                    {formatBytes(f.size)} ·{" "}
                    {f.kind === "manual"
                      ? "Started by you"
                      : f.kind === "scheduled"
                        ? "Automatic"
                        : "Older database copy"}
                  </span>
                  <span className="backup-chips">
                    <StatusChip tone="ok">Database</StatusChip>
                    {f.includesGalleries ? (
                      <StatusChip tone="info">Galleries</StatusChip>
                    ) : null}
                    {f.includesOriginals ? (
                      <StatusChip tone="info">Originals</StatusChip>
                    ) : null}
                  </span>
                </div>
                <div className="backup-acts">
                  <a
                    className="btn sm"
                    href={`/api/studio/backups/files/${encodeURIComponent(f.name)}`}
                    download={f.name}
                  >
                    Download
                  </a>
                  <Button
                    size="sm"
                    disabled={!!restore.busy || !!restore.state?.plan}
                    aria-label={`Restore the backup from ${formatDate(f.createdAt)}`}
                    onClick={() => void restore.fromBackup(f.name)}
                  >
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete the backup from ${formatDate(f.createdAt)}`}
                    onClick={() => void remove(f)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Big photo backups can take a long time to download over the internet.
          Download them on your home network when you can.
        </p>
      </Panel>

      <RestorePanel restore={restore} />
    </div>
  );
}
