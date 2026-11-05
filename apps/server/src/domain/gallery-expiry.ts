import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";
import { tables } from "@openportrait/db";
import type { Originals } from "../galleries/originals.js";
import { resolveInside } from "../galleries/files.js";
import { galleryLink, type Recipient } from "../galleries/mail.js";
import { displayName } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { composeEmail, emailConfigured, queueEmail } from "./email.js";
import { addTask } from "./tasks.js";

const { gallery, galleryArchive, photo, shoot, shootContact, contact } = tables;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Gallery = typeof gallery.$inferSelect;

const DAY = 86_400_000;
/** Days before expiry at which attached clients are reminded. */
export const REMINDER_DAYS = [90, 30, 7] as const;
export const DEFAULT_EXPIRY_MONTHS = 12;
/** Zips live in this folder beside the shoots on the share. Underscore folders are never read as galleries. */
export const ARCHIVE_DIR = "_Archive";

/** Months a gallery stays up after first publish; 0 means never. */
export function expiryMonths(ctx: Pick<ServiceContext, "settings">): number {
  const m = ctx.settings.get("galleries.expiryMonths");
  return typeof m === "number" && m >= 0 && m <= 120 ? m : DEFAULT_EXPIRY_MONTHS;
}

/** The expiry date a gallery published at `from` gets under the studio setting, or null for never. */
export function defaultExpiry(ctx: Pick<ServiceContext, "settings">, from = new Date()): Date | null {
  const months = expiryMonths(ctx);
  if (!months) return null;
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function row(ctx: ServiceContext, id: string): Gallery {
  const g = ctx.db.select().from(gallery).where(eq(gallery.id, id)).get();
  if (!g) throw notFound("Gallery");
  return g;
}

export function archivesOf(ctx: ServiceContext, galleryId: string) {
  return ctx.db
    .select()
    .from(galleryArchive)
    .where(eq(galleryArchive.galleryId, galleryId))
    .orderBy(desc(galleryArchive.createdAt))
    .all()
    .map((a) => ({
      id: a.id,
      fileName: path.basename(a.relPath),
      folder: path.dirname(a.relPath),
      sizeBytes: a.sizeBytes,
      fileCount: a.fileCount,
      reason: a.reason,
      createdAt: a.createdAt.getTime(),
      restoredAt: a.restoredAt?.getTime() ?? null,
      exists: fs.existsSync(path.join(ctx.config.galleriesDir, a.relPath)),
    }));
}

const stamp = (d: Date) => d.toISOString().slice(0, 10);
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80) || "gallery";

/**
 * Packs every photo of a gallery into one zip in the archive folder, checks the zip reads back with the right
 * number of files, and only then marks the gallery archived. The gallery's own files are never deleted. Files
 * that are in remote storage are read from there.
 */
export async function archiveGallery(ctx: ServiceContext, originals: Originals, galleryId: string, reason: "expired" | "manual"): Promise<{ archiveId: string; fileCount: number; sizeBytes: number }> {
  const g = row(ctx, galleryId);
  if (g.archivedAt) throw new DomainError("already_archived", "This gallery is already archived.", 409);
  const photos = ctx.db.select().from(photo).where(and(eq(photo.galleryId, g.id), ne(photo.state, "missing"))).all();
  if (photos.length === 0) throw new DomainError("empty", "This gallery has no photos to archive.", 409);
  const problem = await originals.unreachable(photos);
  if (problem) throw new DomainError("storage_unavailable", "Some of this gallery's files are in remote storage that can't be reached right now. Try again when it is connected.", 409);

  const dir = path.join(ctx.config.galleriesDir, ARCHIVE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  let name = `${safeName(g.title)} (${stamp(now)}).zip`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${safeName(g.title)} (${stamp(now)}) ${n}.zip`;
  const file = path.join(dir, name);
  const part = `${file}.part`;
  const prefix = `${g.shootFolder}/`;

  try {
    const archive = new ZipArchive({ store: true, forceZip64: true });
    const out = fs.createWriteStream(part);
    const done = pipeline(archive, out);
    for (const p of photos) {
      const { stream } = await originals.open(p);
      archive.append(stream, { name: p.relPath.startsWith(prefix) ? p.relPath.slice(prefix.length) : p.relPath, date: new Date(p.mtimeMs) });
      await new Promise<void>((resolve, reject) => {
        stream.once("end", resolve);
        stream.once("error", reject);
      });
    }
    await archive.finalize();
    await done;
    const count = await countEntries(part);
    if (count !== photos.length) throw new Error(`The zip holds ${count} files, not ${photos.length}`);
    fs.renameSync(part, file);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err instanceof DomainError ? err : new DomainError("archive_failed", "The archive could not be made. The gallery was left as it was.", 500);
  }

  const id = newId();
  const sizeBytes = fs.statSync(file).size;
  ctx.db.insert(galleryArchive).values({ id, galleryId: g.id, relPath: `${ARCHIVE_DIR}/${name}`, sizeBytes, fileCount: photos.length, reason }).run();
  ctx.db.update(gallery).set({ status: "archived", archivedAt: now, updatedAt: now }).where(eq(gallery.id, g.id)).run();
  return { archiveId: id, fileCount: photos.length, sizeBytes };
}

function countEntries(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("unreadable zip"));
      let n = 0;
      zip.on("entry", () => {
        n++;
        zip.readEntry();
      });
      zip.on("end", () => resolve(n));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/**
 * Brings an archived gallery back. Files missing from the shoot folder are unpacked from the zip; files still
 * there are left alone. The gallery returns as a draft with a fresh expiry date, so it is not live until the
 * owner publishes it again.
 */
export async function restoreArchive(ctx: ServiceContext, galleryId: string, archiveId: string): Promise<{ restored: number }> {
  const g = row(ctx, galleryId);
  const a = ctx.db.select().from(galleryArchive).where(and(eq(galleryArchive.id, archiveId), eq(galleryArchive.galleryId, g.id))).get();
  if (!a) throw notFound("Archive");
  const zipPath = resolveInside(ctx.config.galleriesDir, a.relPath);
  if (!fs.existsSync(zipPath)) throw new DomainError("missing", "The archive file is no longer in the Archive folder.", 409);
  let restored = 0;
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (e, z) => (e || !z ? reject(new DomainError("unreadable", "The archive can't be read. It may be damaged.", 409)) : resolve(z))));
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          try {
            if (entry.fileName.endsWith("/")) return zip.readEntry();
            if (entry.fileName.split("/").some((p) => p === ".." || p === "") || entry.fileName.includes("\\")) throw new DomainError("unsafe", "The archive holds an unsafe file name, so it was not restored.", 409);
            const dest = resolveInside(ctx.config.galleriesDir, `${g.shootFolder}/${entry.fileName}`);
            if (!fs.existsSync(dest)) {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))));
              await pipeline(stream, fs.createWriteStream(`${dest}.part`));
              fs.renameSync(`${dest}.part`, dest);
              restored++;
            }
            zip.readEntry();
          } catch (e) {
            reject(e);
          }
        })();
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  const now = new Date();
  ctx.db.update(gallery).set({ status: "draft", archivedAt: null, expiresAt: defaultExpiry(ctx, now), expiryReminderDays: 0, updatedAt: now }).where(eq(gallery.id, g.id)).run();
  ctx.db.update(galleryArchive).set({ restoredAt: now }).where(eq(galleryArchive.id, a.id)).run();
  return { restored };
}

export function archiveFile(ctx: ServiceContext, galleryId: string, archiveId: string): { file: string; name: string; size: number } {
  const a = ctx.db.select().from(galleryArchive).where(and(eq(galleryArchive.id, archiveId), eq(galleryArchive.galleryId, galleryId))).get();
  if (!a) throw notFound("Archive");
  const file = resolveInside(ctx.config.galleriesDir, a.relPath);
  if (!fs.existsSync(file)) throw new DomainError("missing", "The archive file is no longer in the Archive folder.", 409);
  return { file, name: path.basename(a.relPath), size: fs.statSync(file).size };
}

/** The reminder due for a gallery, given how many days it has left: the smallest step that has been reached and not yet sent. */
export function reminderDue(daysLeft: number, lastSent: number): number | null {
  const reached = REMINDER_DAYS.filter((d) => daysLeft <= d);
  if (!reached.length) return null;
  const step = Math.min(...reached);
  return lastSent === 0 || step < lastSent ? step : null;
}

/** The people attached to the gallery's shoot in OpenPortrait: its main contact and anyone added to it. Visitors who only registered to view are not included. */
export function attachedClients(ctx: ServiceContext, g: Gallery): Recipient[] {
  if (!g.shootId) return [];
  const cols = { id: contact.id, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email };
  const rows = [
    ...ctx.db.select(cols).from(shoot).innerJoin(contact, eq(contact.id, shoot.primaryContactId)).where(eq(shoot.id, g.shootId)).all(),
    ...ctx.db.select(cols).from(shootContact).innerJoin(contact, eq(contact.id, shootContact.contactId)).where(eq(shootContact.shootId, g.shootId)).all(),
  ];
  const out = new Map<string, Recipient>();
  for (const r of rows) if (r.email && EMAIL.test(r.email) && !out.has(r.email.toLowerCase())) out.set(r.email.toLowerCase(), { name: displayName(r), email: r.email, contactId: r.id });
  return [...out.values()];
}

/** Emails the clients attached to the shoot that the gallery is about to expire. Returns how many were queued. */
export function sendExpiryReminders(ctx: ServiceContext, g: Gallery, daysLeft: number): number {
  if (!emailConfigured(ctx.settings) || !/^https?:\/\//.test(ctx.publicUrl?.() ?? "")) return 0;
  const studio = ctx.settings.get("studio.name") || "Your photographer";
  const date = g.expiresAt!.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: ctx.settings.get("studio.timezone") ?? "UTC" });
  const when = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  let sent = 0;
  for (const r of attachedClients(ctx, g)) {
    const mail = composeEmail(studio, [`Hi ${r.name.split(" ")[0]},`, `Your gallery "${g.title}" will expire ${when}, on ${date}. After that the link stops working.`, `Please download any photos you want to keep before then. If you need more time, just reply to this email.`], { label: "Open your gallery", url: galleryLink(ctx, g) });
    if (queueEmail(ctx, { to: r.email, toName: r.name, subject: `Your gallery "${g.title}" expires ${when}`, text: mail.text, html: mail.html, kind: "gallery_expiry", contactId: r.contactId, shootId: g.shootId, galleryId: g.id })) sent++;
  }
  return sent;
}

let running = false;

/** Runs about hourly: sends due reminders, then archives galleries that have expired. */
export async function tickExpiry(ctx: ServiceContext, originals: Originals, log?: (msg: string, err?: unknown) => void): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const due = ctx.db.select().from(gallery).where(and(eq(gallery.status, "live"), isNotNull(gallery.expiresAt), isNull(gallery.archivedAt))).all();
    const remind = ctx.settings.get("galleries.expiryReminders") !== false;
    for (const g of due) {
      try {
        const left = g.expiresAt!.getTime() - now;
        if (left <= 0) {
          const r = await archiveGallery(ctx, originals, g.id, "expired");
          if (g.shootId) addTask(ctx, g.shootId, { title: `"${g.title}" expired and was archived (${r.fileCount} files). Restore it from the Storage tab if the client needs it.` });
        } else if (remind) {
          const daysLeft = Math.ceil(left / DAY);
          const step = reminderDue(daysLeft, g.expiryReminderDays);
          if (step === null) continue;
          if (sendExpiryReminders(ctx, g, daysLeft) > 0 || attachedClients(ctx, g).length === 0) {
            ctx.db.update(gallery).set({ expiryReminderDays: step }).where(eq(gallery.id, g.id)).run();
          }
        }
      } catch (err) {
        log?.(`expiry check failed for ${g.id}`, err);
      }
    }
  } finally {
    running = false;
  }
}
