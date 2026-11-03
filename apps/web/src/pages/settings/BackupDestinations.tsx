import { AddOnPrompt } from "../../components/AddOnPrompt.js";
import { useState } from "react";
import {
  Button,
  Callout,
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
import { timeAgo } from "../../lib/galleries.js";
import { SwitchRow } from "../../components/SwitchRow.js";

interface FieldDef {
  name: string;
  label: string;
  hint?: string;
  secret?: boolean;
  optional?: boolean;
}
interface Provider {
  kind: string;
  label: string;
  description: string;
  fields: FieldDef[];
}
interface Destination {
  id: string;
  kind: string;
  kindLabel: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  secretsSet: string[];
  lastAt: number | null;
  lastError: string | null;
  lastFile: string | null;
  available: boolean;
}
interface Overview {
  destinations: Destination[];
  providers: Provider[];
}

/** Add or change one destination. Blank secret fields keep what is already saved. */
function DestinationForm({
  providers,
  existing,
  onDone,
  onCancel,
}: {
  providers: Provider[];
  existing?: Destination;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState(
    existing?.kind ?? providers[0]?.kind ?? "folder",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [values, setValues] = useState<Record<string, string>>(
    existing?.config ?? {},
  );
  const provider = providers.find((p) => p.kind === kind);
  const save = useSubmit(async () => {
    const body = { kind, name, enabled, config: values };
    await api(
      existing
        ? `/backups/destinations/${existing.id}`
        : "/backups/destinations",
      { method: existing ? "PUT" : "POST", body },
    );
    toast(existing ? "Destination saved" : "Destination added");
    onDone();
  });

  return (
    <form
      className="backup-dest-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save.submit();
      }}
    >
      {!existing && providers.length > 1 ? (
        <Field label="Where to copy backups">
          {(a) => (
            <select
              {...a}
              className="input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setValues({});
              }}
            >
              {providers.map((p) => (
                <option key={p.kind} value={p.kind}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {provider?.description ? (
        <p className="hint">{provider.description}</p>
      ) : null}
      <Field label="Name" hint="Only you see this, for example “Office NAS”.">
        {(a) => (
          <TextInput
            {...a}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      {provider?.fields.map((f) => (
        <Field
          key={f.name}
          label={f.label}
          hint={
            f.secret && existing?.secretsSet.includes(f.name)
              ? "Saved. Leave blank to keep it."
              : f.hint
          }
        >
          {(a) => (
            <TextInput
              {...a}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              value={values[f.name] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.name]: e.target.value })
              }
            />
          )}
        </Field>
      ))}
      <SwitchRow
        checked={enabled}
        onChange={setEnabled}
        label="Copy new backups here"
      />
      {save.error ? (
        <Callout tone="bad" title="Couldn't save">
          {save.error}
        </Callout>
      ) : null}
      <div className="backup-dest-actions">
        <Button
          variant="primary"
          type="submit"
          loading={save.busy}
          disabled={!name.trim()}
        >
          {existing ? "Save destination" : "Check and add"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Settings > Backups: other places each backup is copied to after it is made. */
export function BackupDestinationsPanel() {
  const toast = useToast();
  const { data, error, reload } = useLoad<Overview>("/backups/destinations");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  if (error)
    return (
      <Callout tone="bad" title="Couldn't load destinations">
        {error}
      </Callout>
    );
  if (!data) return <Spinner label="Loading destinations" />;

  const finish = () => {
    setEditing(null);
    reload();
  };
  const test = async (d: Destination) => {
    setTesting(d.id);
    try {
      await api(`/backups/destinations/${d.id}/test`, {
        method: "POST",
        body: {},
      });
      toast(`${d.name} is reachable`);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setTesting(null);
    }
  };
  const remove = async (d: Destination) => {
    if (
      !window.confirm(
        `Stop copying backups to “${d.name}”? Backups already there stay where they are.`,
      )
    )
      return;
    try {
      await api(`/backups/destinations/${d.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  return (
    <Panel
      title="Copy backups somewhere else"
      description="A backup on the same disk as your studio doesn't survive that disk failing. Add one or more places each backup is copied to, such as another drive or a network share."
      actions={
        editing ? undefined : (
          <Button icon="plus" onClick={() => setEditing("new")}>
            Add a destination
          </Button>
        )
      }
    >
      {editing === "new" ? (
        <DestinationForm
          providers={data.providers}
          onDone={finish}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <AddOnPrompt feature="bucket-storage" />
      {data.destinations.length === 0 && editing !== "new" ? (
        <Callout tone="warn" title="Backups stay on this server only">
          If this server's disk fails or is lost, the backups go with it. Add a
          destination so every backup is also copied somewhere else.
        </Callout>
      ) : (
        <ul className="backup-list">
          {data.destinations.map((d) =>
            editing === d.id ? (
              <li key={d.id} className="backup-row">
                <DestinationForm
                  providers={data.providers}
                  existing={d}
                  onDone={finish}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={d.id} className="backup-row">
                <div className="backup-main">
                  <b>{d.name}</b>
                  <span className="hint">
                    {d.kindLabel}
                    {d.config.path ? ` · ${d.config.path}` : ""}
                  </span>
                  <span className="backup-chips">
                    {!d.available ? (
                      <StatusChip tone="warn">Not available</StatusChip>
                    ) : !d.enabled ? (
                      <StatusChip>Paused</StatusChip>
                    ) : d.lastError ? (
                      <StatusChip tone="bad">Last copy failed</StatusChip>
                    ) : d.lastAt ? (
                      <StatusChip tone="ok">
                        Copied {timeAgo(d.lastAt)}
                      </StatusChip>
                    ) : (
                      <StatusChip>Waiting for the next backup</StatusChip>
                    )}
                  </span>
                  {d.lastError ? (
                    <span className="hint backup-error" role="alert">
                      {d.lastError}
                    </span>
                  ) : null}
                </div>
                <div className="backup-acts">
                  <Button
                    size="sm"
                    loading={testing === d.id}
                    disabled={!d.available}
                    onClick={() => void test(d)}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(d.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${d.name}`}
                    onClick={() => void remove(d)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </Panel>
  );
}
