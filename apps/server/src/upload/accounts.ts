import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import ssh2 from "ssh2";
import { tables, type Db } from "@openportrait/db";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth.js";
import { DomainError } from "../domain/context.js";
import { safeSegment } from "../domain/folders.js";

const { utils } = ssh2;

export type CameraAccountRow = typeof tables.cameraAccount.$inferSelect;

/** What the servers need to know about a login. Never includes the hash. */
export interface CameraLogin {
  id: string;
  label: string;
  username: string;
  folder: string;
  publicKey: string | null;
}

/** Letters and digits only, without look-alikes (0/O, 1/l/I), because passwords get typed on a camera's on-screen keyboard. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePassword(length = 16): string {
  let out = "";
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0]!;
    if (byte < 256 - (256 % ALPHABET.length)) out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** A short lowercase login name from the label, such as "Nikon Z9" -> "nikon-z9". */
export function usernameFromLabel(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/[^a-z0-9-]/gi, "")
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "camera";
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** Parses an OpenSSH public key line, rejecting private keys and junk. Returns the normalized line. */
export function normalizePublicKey(input: string): string {
  const line = input.trim();
  const parsed = utils.parseKey(line);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new DomainError("invalid", "That isn't a valid SSH public key. Paste the single line from your .pub file.");
  if (key.isPrivateKey()) throw new DomainError("invalid", "That looks like a private key. Paste the public key (the .pub file) instead.");
  return line.split(/\s+/).slice(0, 2).join(" ");
}

export class CameraAccounts {
  constructor(private readonly db: Db) {}

  list(): Array<Omit<CameraAccountRow, "passwordHash"> & { hasPassword: boolean }> {
    return this.db
      .select()
      .from(tables.cameraAccount)
      .all()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(({ passwordHash, ...rest }) => ({ ...rest, hasPassword: passwordHash !== "" }));
  }

  private byUsername(username: string): CameraAccountRow | undefined {
    return this.db.select().from(tables.cameraAccount).where(eq(tables.cameraAccount.username, username.toLowerCase())).get();
  }

  private uniqueUsername(base: string): string {
    let name = base;
    for (let n = 2; this.byUsername(name); n++) name = `${base.slice(0, 28)}-${n}`;
    return name;
  }

  private uniqueFolder(base: string): string {
    const taken = new Set(this.db.select({ f: tables.cameraAccount.folder }).from(tables.cameraAccount).all().map((r) => r.f.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
  }

  async create(input: { label: string; username?: string; publicKey?: string }): Promise<{ account: CameraLogin; password: string }> {
    const label = input.label.trim();
    if (!label) throw new DomainError("invalid", "Name the camera, for example Nikon Z9.");
    let username = (input.username ?? "").trim().toLowerCase();
    if (username) {
      if (!USERNAME.test(username)) throw new DomainError("invalid", "Usernames use 2 to 32 lowercase letters, digits, dots, dashes or underscores.");
      if (this.byUsername(username)) throw new DomainError("conflict", "Another camera already uses that username.", 409);
    } else {
      username = this.uniqueUsername(usernameFromLabel(label));
    }
    const folder = this.uniqueFolder(safeSegment(label) || "Camera");
    const password = generatePassword();
    const id = crypto.randomUUID();
    const publicKey = input.publicKey?.trim() ? normalizePublicKey(input.publicKey) : null;
    this.db
      .insert(tables.cameraAccount)
      .values({ id, label, username, passwordHash: await hashPassword(password), publicKey, folder })
      .run();
    return { account: { id, label, username, folder, publicKey }, password };
  }

  async resetPassword(id: string): Promise<string> {
    this.mustGet(id);
    const password = generatePassword();
    this.db.update(tables.cameraAccount).set({ passwordHash: await hashPassword(password) }).where(eq(tables.cameraAccount.id, id)).run();
    return password;
  }

  update(id: string, patch: { label?: string; publicKey?: string | null; disabled?: boolean }): void {
    this.mustGet(id);
    const set: Partial<typeof tables.cameraAccount.$inferInsert> = {};
    if (patch.label !== undefined) {
      if (!patch.label.trim()) throw new DomainError("invalid", "Name the camera, for example Nikon Z9.");
      set.label = patch.label.trim();
    }
    if (patch.publicKey !== undefined) set.publicKey = patch.publicKey?.trim() ? normalizePublicKey(patch.publicKey) : null;
    if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? new Date() : null;
    if (Object.keys(set).length) this.db.update(tables.cameraAccount).set(set).where(eq(tables.cameraAccount.id, id)).run();
  }

  /** Removes the login. Photos it uploaded stay in Incoming. */
  remove(id: string): void {
    this.mustGet(id);
    this.db.delete(tables.cameraAccount).where(eq(tables.cameraAccount.id, id)).run();
  }

  private mustGet(id: string): CameraAccountRow {
    const row = this.db.select().from(tables.cameraAccount).where(eq(tables.cameraAccount.id, id)).get();
    if (!row) throw new DomainError("not_found", "That camera login doesn't exist.", 404);
    return row;
  }

  /** Looks up an enabled login by username (for key authentication). */
  find(username: string): CameraLogin | null {
    const row = this.byUsername(username);
    if (!row || row.disabledAt) return null;
    return { id: row.id, label: row.label, username: row.username, folder: row.folder, publicKey: row.publicKey };
  }

  /** Checks a password. Takes the same time whether or not the username exists. */
  async verify(username: string, password: string): Promise<CameraLogin | null> {
    const row = this.byUsername(username);
    if (!row || row.disabledAt) {
      await burnPasswordCheck(password);
      return null;
    }
    if (!(await verifyPassword(row.passwordHash, password))) return null;
    this.db.update(tables.cameraAccount).set({ lastLoginAt: new Date() }).where(eq(tables.cameraAccount.id, row.id)).run();
    return { id: row.id, label: row.label, username: row.username, folder: row.folder, publicKey: row.publicKey };
  }

  recordUpload(id: string, bytes: number): void {
    const row = this.db.select().from(tables.cameraAccount).where(eq(tables.cameraAccount.id, id)).get();
    if (!row) return;
    this.db
      .update(tables.cameraAccount)
      .set({ lastUploadAt: new Date(), filesReceived: row.filesReceived + 1, bytesReceived: row.bytesReceived + bytes })
      .where(eq(tables.cameraAccount.id, id))
      .run();
  }
}
