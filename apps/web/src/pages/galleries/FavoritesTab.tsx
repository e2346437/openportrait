import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Dialog, EmptyState, Field, Icon, Panel, Spinner, StatusChip, TextInput, useToast } from "@openportrait/ui";
import { api } from "../../lib/api.js";
import { formatDate, plural, type FavoriteListInfo, type GalleryDetail, type Selection } from "../../lib/galleries.js";
import type { Patch } from "./GalleryDetail.js";

export function FavoritesTab({ data, patch }: { data: GalleryDetail; patch: Patch }) {
  const toast = useToast();
  const id = data.gallery.id;
  const [selections, setSelections] = useState<Selection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FavoriteListInfo | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setSelections((await api<{ selections: Selection[] }>(`/galleries/${id}/favorites`)).selections);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const lightroom = (s: Selection) => s.items.map((i) => i.filename.replace(/\.[^.]+$/, "")).join(", ");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it into Lightroom's text filter.");
    } catch {
      toast("Couldn't copy. Select the text and copy it by hand.", "bad");
    }
  };

  return (
    <div className="fav-tab">
      <Panel
        title="Favorites lists"
        description="Clients can have several lists, such as one for album picks capped at 40 and another for prints. Each is sent to you separately."
        actions={
          <Button size="sm" icon="plus" onClick={() => setEditing("new")}>
            Add list
          </Button>
        }
      >
        <ul className="list-rows">
          {data.lists.map((l) => (
            <li key={l.id}>
              <div>
                <b>{l.name}</b>
                <span className="muted">{l.maxCount ? `Up to ${plural(l.maxCount, "photo")}` : "No limit"}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="What clients picked">
        {error ? (
          <Callout tone="bad" title="Couldn't load favorites" action={<Button size="sm" onClick={load}>Try again</Button>}>
            {error}
          </Callout>
        ) : selections === null ? (
          <div className="detail-loading">
            <Spinner label="Loading favorites" />
          </div>
        ) : selections.length === 0 ? (
          <EmptyState icon="heart" title="No favorites yet">
            When clients tap the heart on photos, their picks show up here, and you're told when they send a list.
          </EmptyState>
        ) : (
          <ul className="fav-sels">
            {selections.map((s) => (
              <li key={s.id} className="fav-sel">
                <div className="fav-head">
                  <div className="who">
                    <b>{s.clientEmail}</b>
                    <span className="muted">
                      {s.listName} · {plural(s.items.length, "photo")}
                    </span>
                  </div>
                  {s.submittedAt ? <StatusChip tone="ok">Sent {formatDate(s.submittedAt)}</StatusChip> : <StatusChip>Still choosing</StatusChip>}
                  {s.submittedAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api(`/galleries/${id}/favorites/${s.id}/reopen`, { method: "POST", body: {} });
                        toast("Reopened. The client can edit this list again.");
                        void load();
                      }}
                    >
                      Reopen
                    </Button>
                  ) : null}
                </div>
                {s.items.length ? (
                  <>
                    <p className="lr mono">{lightroom(s)}</p>
                    <div>
                      <Button size="sm" icon="copy" onClick={() => copy(lightroom(s))}>
                        Copy filenames
                      </Button>
                    </div>
                    {s.items.some((i) => i.note) ? (
                      <ul className="notes">
                        {s.items
                          .filter((i) => i.note)
                          .map((i) => (
                            <li key={i.photoId}>
                              <Icon name="note" /> <b className="mono">{i.filename}</b> {i.note}
                            </li>
                          ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ListDialog
        key={typeof editing === "object" && editing ? editing.id : editing ?? "closed"}
        state={editing}
        canDelete={data.lists.length > 1}
        onClose={() => setEditing(null)}
        onSave={async (name, maxCount) => {
          const ok = editing === "new" ? await patch("/lists", { name, maxCount }, "POST") : editing ? await patch(`/lists/${editing.id}`, { name, maxCount }) : undefined;
          if (ok) setEditing(null);
        }}
        onDelete={async () => {
          if (editing && editing !== "new" && (await patch(`/lists/${editing.id}`, undefined, "DELETE"))) {
            setEditing(null);
            void load();
          }
        }}
      />
    </div>
  );
}

function ListDialog({ state, canDelete, onClose, onSave, onDelete }: { state: FavoriteListInfo | "new" | null; canDelete: boolean; onClose: () => void; onSave: (name: string, maxCount: number | null) => Promise<void>; onDelete: () => Promise<void> }) {
  const existing = state && state !== "new" ? state : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [max, setMax] = useState(existing?.maxCount ? String(existing.maxCount) : "");
  const [busy, setBusy] = useState(false);
  const n = max.trim() === "" ? null : Number(max);
  const bad = n !== null && (!Number.isInteger(n) || n < 1);
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title={existing ? "Edit list" : "Add a favorites list"}
      footer={
        <>
          {existing && canDelete ? (
            <Button variant="danger" className="push-left" onClick={onDelete}>
              Delete list
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || bad}
            onClick={async () => {
              setBusy(true);
              await onSave(name.trim(), n);
              setBusy(false);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">{(p) => <TextInput {...p} value={name} maxLength={60} placeholder="Album picks" onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
      <Field label="Photo limit" hint="Leave empty for no limit." error={bad ? "Enter a whole number, 1 or more." : null}>
        {(p) => <TextInput {...p} inputMode="numeric" value={max} placeholder="No limit" onChange={(e) => setMax(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
