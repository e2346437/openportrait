import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backupProviders } from "./extension-hooks.js";
import type { BackupProvider } from "./extensions.js";
import type { Settings } from "./settings.js";

/** One saved place backups are copied to. `config` holds the provider's values, secrets included, and is stored encrypted. */
export interface Destination {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  lastAt?: number;
  lastError?: string;
  lastFile?: string;
}

/** What the page sees: secret values are replaced by a flag saying one is saved. */
export interface DestinationView {
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
  /** False when the extension that provides this kind isn't loaded right now. */
  available: boolean;
}

const BACKUP_FILE = /^openportrait-(?:manual-)?[0-9TZ-]+\.(?:zip|db)$/;

/** Copies backups into a folder on this server: another disk, a USB drive, or a network share mounted into the container. */
export const folderProvider: BackupProvider = {
  kind: "folder",
  label: "Folder or network share",
  description: "A folder inside the container, such as an Unraid share you mapped to it. Use a different disk from your config folder.",
  fields: [{ name: "path", label: "Folder path", hint: "For example /backups. Map the share to this path in your container settings." }],
  async check(config) {
    const dir = folderOf(config);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      throw new Error(`The folder ${dir} doesn't exist inside OpenPortrait. Map a share to it in your container settings, then try again.`);
    }
    if (!st.isDirectory()) throw new Error(`${dir} is a file, not a folder.`);
    const probe = path.join(dir, `.openportrait-write-test-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe);
    } catch {
      throw new Error(`OpenPortrait can't write to ${dir}. Check that the share is writable.`);
    }
  },
  async upload(config, file) {
    const dir = folderOf(config);
    const tmp = path.join(dir, `.${file.name}.partial`);
    try {
      await fs.promises.copyFile(file.path, tmp);
      await fs.promises.rename(tmp, path.join(dir, file.name));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Couldn't copy to ${dir}: ${(err as NodeJS.ErrnoException).code === "ENOSPC" ? "the disk is full." : (err as Error).message}`);
    }
  },
  async list(config) {
    return fs.readdirSync(folderOf(config)).filter((n) => BACKUP_FILE.test(n)).map((name) => ({ name }));
  },
  async remove(config, name) {
    if (BACKUP_FILE.test(name)) fs.rmSync(path.join(folderOf(config), name), { force: true });
  },
};

function folderOf(config: Record<string, string>): string {
  const p = (config.path ?? "").trim();
  if (!p || !path.isAbsolute(p)) throw new Error("Enter the folder's full path, starting with /.");
  const resolved = path.resolve(p);
  if (resolved === path.parse(resolved).root) throw new Error("Choose a folder, not the root of the disk.");
  return resolved;
}

export function providerFor(kind: string): BackupProvider | undefined {
  return kind === "folder" ? folderProvider : backupProviders.find((p) => p.kind === kind);
}

export function allProviders(): BackupProvider[] {
  return [folderProvider, ...backupProviders];
}

export class DestinationStore {
  constructor(private readonly settings: Settings) {}

  all(): Destination[] {
    try {
      const parsed = JSON.parse(this.settings.get("backup.destinations") ?? "[]") as Destination[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(list: Destination[]) {
    this.settings.set("backup.destinations", JSON.stringify(list));
  }

  get(id: string): Destination | undefined {
    return this.all().find((d) => d.id === id);
  }

  view(d: Destination): DestinationView {
    const p = providerFor(d.kind);
    const secrets = new Set((p?.fields ?? []).filter((f) => f.secret).map((f) => f.name));
    const config: Record<string, string> = {};
    const secretsSet: string[] = [];
    for (const [k, v] of Object.entries(d.config)) {
      if (secrets.has(k)) {
        if (v) secretsSet.push(k);
      } else config[k] = v;
    }
    return { id: d.id, kind: d.kind, kindLabel: p?.label ?? d.kind, name: d.name, enabled: d.enabled, config, secretsSet, lastAt: d.lastAt ?? null, lastError: d.lastError ?? null, lastFile: d.lastFile ?? null, available: !!p };
  }

  /** Validates `input` against the provider and its connection, then saves. Blank secret fields keep the saved value. */
  async upsert(input: { id?: string; kind: string; name: string; enabled: boolean; config: Record<string, string> }): Promise<Destination> {
    const provider = providerFor(input.kind);
    if (!provider) throw new Error("That kind of destination isn't available.");
    const list = this.all();
    const existing = input.id ? list.find((d) => d.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("That destination no longer exists.");
    const config: Record<string, string> = {};
    for (const f of provider.fields) {
      let v = (input.config[f.name] ?? "").trim();
      if (!v && f.secret && existing) v = existing.config[f.name] ?? "";
      if (!v && !f.optional) throw new Error(`Enter ${f.label.toLowerCase()}.`);
      config[f.name] = v;
    }
    await provider.check(config);
    const saved: Destination = { ...(existing ?? { id: crypto.randomUUID() }), kind: input.kind, name: input.name, enabled: input.enabled, config };
    this.save(existing ? list.map((d) => (d.id === saved.id ? saved : d)) : [...list, saved]);
    return saved;
  }

  remove(id: string): boolean {
    const list = this.all();
    if (!list.some((d) => d.id === id)) return false;
    this.save(list.filter((d) => d.id !== id));
    return true;
  }

  record(id: string, result: { ok: true; file: string } | { ok: false; error: string }) {
    const list = this.all();
    const d = list.find((x) => x.id === id);
    if (!d) return;
    d.lastAt = Date.now();
    if (result.ok) {
      d.lastError = undefined;
      d.lastFile = result.file;
    } else d.lastError = result.error;
    this.save(list);
  }
}
