import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Button, Dialog, Icon, TextInput } from "@openportrait/ui";
import { plural, type StudioSet } from "../lib/galleries.js";

const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 2;
const NEW_SET = "__new__";

type State = "waiting" | "sending" | "done" | "failed" | "paused";
interface Item {
  key: string;
  file: File;
  set: string;
  state: State;
  sent: number;
  message?: string;
}

class Stop extends Error {}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

/**
 * Sends a file in chunks, asking the server where it stopped after any failure. The server maps the same
 * file to the same upload, so a file picked again after a closed tab or a dropped connection continues.
 */
async function sendFile(galleryId: string, item: Item, signal: AbortSignal, progress: (sent: number) => void): Promise<void> {
  const start = await fetch("/api/studio/uploads", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ galleryId, set: item.set, filename: item.file.name, size: item.file.size, lastModified: item.file.lastModified }),
    signal,
  });
  const info = await json<{ id?: string; offset?: number; message?: string }>(start);
  if (!start.ok || !info.id) throw Object.assign(new Error(info.message ?? "Couldn't start the upload."), { fatal: true });
  let offset = info.offset ?? 0;
  progress(offset);
  let failures = 0;
  while (offset < item.file.size) {
    const end = Math.min(offset + CHUNK, item.file.size);
    try {
      const res = await fetch(`/api/studio/uploads/${info.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/offset+octet-stream", "upload-offset": String(offset) },
        body: item.file.slice(offset, end),
        signal,
      });
      const body = await json<{ offset?: number; message?: string }>(res);
      if (res.status === 409 && typeof body.offset === "number") {
        offset = body.offset; // the server is somewhere else: carry on from there
      } else if (!res.ok) {
        if (res.status < 500 && res.status !== 408 && res.status !== 429) throw Object.assign(new Error(body.message ?? "The server refused this file."), { fatal: true });
        throw new Error(body.message ?? "The server had a problem.");
      } else {
        offset = body.offset ?? end;
      }
      failures = 0;
      progress(offset);
    } catch (e) {
      if (signal.aborted) throw new Stop();
      if ((e as { fatal?: boolean }).fatal || ++failures > 6) throw e;
      await sleep(Math.min(1000 * 2 ** failures, 15_000)); // connection dropped: wait, then ask where we are
      try {
        const where = await fetch(`/api/studio/uploads/${info.id}`, { credentials: "same-origin", signal });
        if (where.ok) offset = (await json<{ offset: number }>(where)).offset;
      } catch {
        /* still offline; the next loop tries again */
      }
    }
  }
}

export function UploadDialog({ open, onClose, galleryId, sets, defaultSet, onUploaded }: { open: boolean; onClose: () => void; galleryId: string; sets: StudioSet[]; defaultSet: string | null; onUploaded: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [target, setTarget] = useState<string>(defaultSet ?? "");
  const [newName, setNewName] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const running = useRef(false);
  const itemsRef = useRef<Item[]>([]);
  const claimed = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  itemsRef.current = items;

  useEffect(() => {
    if (open) setTarget(defaultSet ?? "");
  }, [open, defaultSet]);

  const patchItem = useCallback((key: string, p: Partial<Item>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    abort.current = new AbortController();
    const { signal } = abort.current;
    let uploaded = 0;
    const worker = async () => {
      for (;;) {
        const next = itemsRef.current.find((i) => i.state === "waiting" && !claimed.current.has(i.key));
        if (!next || signal.aborted) return;
        claimed.current.add(next.key);
        patchItem(next.key, { state: "sending", message: undefined });
        try {
          await sendFile(galleryId, next, signal, (sent) => patchItem(next.key, { sent }));
          patchItem(next.key, { state: "done", sent: next.file.size });
          uploaded++;
        } catch (e) {
          if (e instanceof Stop) patchItem(next.key, { state: "paused" });
          else patchItem(next.key, { state: "failed", message: (e as Error).message });
        } finally {
          claimed.current.delete(next.key);
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    running.current = false;
    setTick((t) => t + 1);
    if (uploaded) onUploaded();
  }, [galleryId, onUploaded, patchItem]);

  const setName = target === NEW_SET ? newName.trim() : target;
  const add = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => /\.(jpe?g|png|webp|tiff?|heic|heif|avif)$/i.test(f.name));
    if (!list.length) return;
    setItems((all) => [...all, ...list.map((file) => ({ key: `${Math.random().toString(36).slice(2)}`, file, set: setName, state: "waiting" as const, sent: 0 }))]);
  };

  // New or retried files start uploading; so do any that arrived while the last batch was finishing.
  useEffect(() => {
    if (items.some((i) => i.state === "waiting") && !running.current) void pump();
  }, [items, pump, tick]);

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  const done = items.filter((i) => i.state === "done").length;
  const failed = items.filter((i) => i.state === "failed" || i.state === "paused");
  const active = items.some((i) => i.state === "sending" || i.state === "waiting");
  const total = items.reduce((n, i) => n + i.file.size, 0);
  const sent = items.reduce((n, i) => n + (i.state === "done" ? i.file.size : i.sent), 0);
  const blocked = target === NEW_SET && !newName.trim();

  const stop = () => abort.current?.abort();
  const retry = () => {
    setItems((all) => all.map((i) => (i.state === "failed" || i.state === "paused" ? { ...i, state: "waiting", message: undefined } : i)));
  };
  const close = () => {
    stop();
    setItems((all) => all.filter((i) => i.state !== "done"));
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} wide title="Upload photos" description="Send exported photos from anywhere. Uploads continue where they stopped if your connection drops or you close this page.">
      <div className="up-target">
        <label htmlFor="up-set" className="label">
          Put them in
        </label>
        <select id="up-set" className="input" value={target} onChange={(e) => setTarget(e.target.value)} disabled={active}>
          <option value="">The top of the gallery</option>
          {sets.filter((s) => s.folderName).map((s) => (
            <option key={s.id} value={s.folderName}>
              {s.name}
            </option>
          ))}
          <option value={NEW_SET}>A new set…</option>
        </select>
        {target === NEW_SET ? <TextInput aria-label="New set name" placeholder="Set name, e.g. Ceremony" maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value.replace(/[\\/]/g, ""))} autoFocus /> : null}
      </div>

      <div className={`up-drop${over ? " over" : ""}${blocked ? " off" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={blocked ? undefined : drop}>
        <Icon name="image" />
        <b>Drop photos here</b>
        <span>JPEG, PNG, WebP, TIFF or HEIC</span>
        <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,image/tiff,image/heic,image/heif,image/avif,.jpg,.jpeg,.png,.webp,.tif,.tiff,.heic,.heif,.avif" hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
        <Button variant="primary" icon="plus" disabled={blocked} onClick={() => input.current?.click()}>
          Choose photos
        </Button>
        {blocked ? <span className="hint">Name the new set first.</span> : null}
      </div>

      {items.length ? (
        <div className="up-list" aria-live="polite">
          <div className="up-sum">
            <b>{done === items.length ? `${plural(done, "photo")} uploaded` : `${done} of ${items.length} uploaded`}</b>
            <span>
              {size(sent)} of {size(total)}
            </span>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={total ? Math.round((sent / total) * 100) : 0}>
              <i style={{ width: `${total ? (sent / total) * 100 : 0}%` }} />
            </div>
          </div>
          {failed.length ? (
            <div className="up-fail" role="alert">
              <span>
                {plural(failed.length, "photo")} didn't finish.{failed[0]?.message ? ` ${failed[0].message}` : ""}
              </span>
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            </div>
          ) : null}
          <ul>
            {items.map((i) => (
              <li key={i.key} className={i.state}>
                <Icon name={i.state === "done" ? "check" : i.state === "failed" ? "alert" : "image"} />
                <span className="nm">{i.file.name}</span>
                <span className="st">{i.state === "done" ? "Done" : i.state === "failed" ? "Failed" : i.state === "paused" ? "Paused" : i.state === "waiting" ? "Waiting" : `${Math.round((i.sent / i.file.size) * 100)}%`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="up-foot">
        {active ? (
          <Button variant="ghost" onClick={stop}>
            Pause
          </Button>
        ) : null}
        <Button variant={done && !active ? "primary" : undefined} onClick={close}>
          {active ? "Pause and close" : "Done"}
        </Button>
      </div>
    </Dialog>
  );
}
