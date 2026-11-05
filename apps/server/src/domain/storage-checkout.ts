import { eq, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import type { Originals } from "../galleries/originals.js";
import { DomainError, linkTo, notFound, type ServiceContext } from "./context.js";
import { composeEmail, queueEmail } from "./email.js";
import { addTask } from "./tasks.js";

const { gallery, photo, rawFile } = tables;

export type CheckoutFolders = "originals" | "gallery" | "both";
type Choice = "default" | "local" | "offsite";

const DAY = 86_400_000;
export const DEFAULT_RETURN_DAYS = 14;

export interface CheckoutView {
  /** none: not checked out. preparing: files are coming back. ready: everything is on this server. */
  state: "none" | "preparing" | "ready";
  folders: CheckoutFolders | null;
  checkedOutAt: number | null;
  readyAt: number | null;
  returnDays: number;
  /** When it returns offsite by itself, once ready. */
  returnsAt: number | null;
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  remainingFiles: number;
}

function row(ctx: ServiceContext, id: string) {
  const g = ctx.db.select().from(gallery).where(eq(gallery.id, id)).get();
  if (!g) throw notFound("Gallery");
  return g;
}

/** Files still in the store, for the folders that were checked out. */
function remaining(ctx: ServiceContext, originals: Originals, folder: string, which: CheckoutFolders | null): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (which === "originals" || which === "both") {
    const c = originals.raw.counts(folder);
    files += c.remote;
    bytes += c.remoteBytes;
  }
  if (which === "gallery" || which === "both") {
    const c = originals.counts(folder);
    files += c.remote;
    bytes += c.remoteBytes;
  }
  return { files, bytes };
}

/** The newest change among the shoot's files, so editing counts as use and keeps it checked out. */
function lastActivity(ctx: ServiceContext, g: typeof gallery.$inferSelect): number {
  const a = ctx.db.select({ m: sql<number>`coalesce(max(${photo.mtimeMs}), 0)` }).from(photo).where(eq(photo.galleryId, g.id)).get()?.m ?? 0;
  const b = ctx.db.select({ m: sql<number>`coalesce(max(${rawFile.mtimeMs}), 0)` }).from(rawFile).where(eq(rawFile.shootFolder, g.shootFolder)).get()?.m ?? 0;
  return Math.max(a, b, g.checkoutReadyAt?.getTime() ?? 0, g.checkedOutAt?.getTime() ?? 0);
}

export function checkoutView(ctx: ServiceContext, originals: Originals, galleryId: string): CheckoutView {
  const g = row(ctx, galleryId);
  if (!g.checkedOutAt) {
    return { state: "none", folders: null, checkedOutAt: null, readyAt: null, returnDays: g.checkoutReturnDays, returnsAt: null, totalFiles: 0, doneFiles: 0, totalBytes: 0, remainingFiles: 0 };
  }
  const left = remaining(ctx, originals, g.shootFolder, g.checkoutFolders);
  const ready = !!g.checkoutReadyAt;
  return {
    state: ready ? "ready" : "preparing",
    folders: g.checkoutFolders,
    checkedOutAt: g.checkedOutAt.getTime(),
    readyAt: g.checkoutReadyAt?.getTime() ?? null,
    returnDays: g.checkoutReturnDays,
    returnsAt: ready ? lastActivity(ctx, g) + g.checkoutReturnDays * DAY : null,
    totalFiles: g.checkoutTotalFiles,
    doneFiles: Math.max(0, g.checkoutTotalFiles - left.files),
    totalBytes: g.checkoutTotalBytes,
    remainingFiles: left.files,
  };
}

/** Bring a shoot's offsite files back to this server for editing. */
export function startCheckout(ctx: ServiceContext, originals: Originals, galleryId: string, input: { folders: CheckoutFolders; returnDays?: number }): CheckoutView {
  const g = row(ctx, galleryId);
  if (!originals.hasStore()) throw new DomainError("no_storage", "There is no remote storage connected, so nothing is offsite.", 409);
  if (g.checkedOutAt) throw new DomainError("already_checked_out", "This shoot is already checked out.", 409);
  if (!["originals", "gallery", "both"].includes(input.folders)) throw new DomainError("invalid", "Choose the Originals folder, the Gallery folder, or both.");
  const days = Math.round(input.returnDays ?? DEFAULT_RETURN_DAYS);
  if (!(days >= 1 && days <= 365)) throw new DomainError("invalid", "Return after between 1 and 365 days.");
  const left = remaining(ctx, originals, g.shootFolder, input.folders);
  if (left.files === 0) throw new DomainError("nothing_offsite", "Nothing from that folder is offsite right now.", 409);
  const prev = { originals: g.storageOriginals, gallery: g.storageGallery };
  const set: Partial<typeof gallery.$inferInsert> = {
    checkedOutAt: new Date(),
    checkoutFolders: input.folders,
    checkoutReturnDays: days,
    checkoutPrev: JSON.stringify(prev),
    checkoutTotalFiles: left.files,
    checkoutTotalBytes: left.bytes,
    checkoutReadyAt: null,
    updatedAt: new Date(),
  };
  if (input.folders !== "gallery") set.storageOriginals = "local";
  if (input.folders !== "originals") set.storageGallery = "local";
  ctx.db.update(gallery).set(set).where(eq(gallery.id, g.id)).run();
  return checkoutView(ctx, originals, g.id);
}

/** Done editing: the shoot goes back to the choices it had, and the next sweep moves the files offsite again. */
export function checkIn(ctx: ServiceContext, originals: Originals, galleryId: string): CheckoutView {
  const g = row(ctx, galleryId);
  if (!g.checkedOutAt) throw new DomainError("not_checked_out", "This shoot is not checked out.", 409);
  let prev: { originals?: Choice; gallery?: Choice } = {};
  try {
    prev = JSON.parse(g.checkoutPrev ?? "{}");
  } catch {
    /* fall back to following the studio default */
  }
  const ok = (c: unknown): c is Choice => c === "default" || c === "local" || c === "offsite";
  const set: Partial<typeof gallery.$inferInsert> = { checkedOutAt: null, checkoutFolders: null, checkoutPrev: null, checkoutReadyAt: null, checkoutTotalFiles: 0, checkoutTotalBytes: 0, updatedAt: new Date() };
  if (g.checkoutFolders !== "gallery") set.storageOriginals = ok(prev.originals) ? prev.originals : "default";
  if (g.checkoutFolders !== "originals") set.storageGallery = ok(prev.gallery) ? prev.gallery : "default";
  ctx.db.update(gallery).set(set).where(eq(gallery.id, g.id)).run();
  return checkoutView(ctx, originals, g.id);
}

/**
 * Runs about once a minute. Marks a checkout ready (and tells the owner) when the last file is back, and checks
 * a shoot in on its own after it has sat idle for its return period.
 */
export function tickCheckouts(ctx: ServiceContext, originals: Originals): void {
  const open = ctx.db.select().from(gallery).where(sql`${gallery.checkedOutAt} is not null`).all();
  for (const g of open) {
    try {
      if (!g.checkoutReadyAt) {
        if (remaining(ctx, originals, g.shootFolder, g.checkoutFolders).files > 0) continue;
        ctx.db.update(gallery).set({ checkoutReadyAt: new Date(), updatedAt: new Date() }).where(eq(gallery.id, g.id)).run();
        notifyReady(ctx, g);
      } else if (Date.now() - lastActivity(ctx, g) > g.checkoutReturnDays * DAY) {
        checkIn(ctx, originals, g.id);
      }
    } catch (err) {
      void err; // one bad row must not stop the others
    }
  }
}

function notifyReady(ctx: ServiceContext, g: typeof gallery.$inferSelect): void {
  const what = g.checkoutFolders === "originals" ? "originals" : g.checkoutFolders === "gallery" ? "gallery files" : "originals and gallery files";
  const title = `${g.title}: ${what} are back on this server`;
  if (g.shootId) {
    try {
      addTask(ctx, g.shootId, { title: `Ready to edit: ${g.title}` });
    } catch {
      /* the shoot may be gone */
    }
  }
  const to = ctx.settings.get("studio.email");
  if (!to) return;
  const studio = ctx.settings.get("studio.name") || "Your studio";
  const mail = composeEmail(studio, [`${title}.`, `They stay here until you check the shoot in, or for ${g.checkoutReturnDays} days after your last change, then they go back offsite.`], { label: "Open the shoot", url: linkTo(ctx, `/studio/galleries/${g.id}`) });
  queueEmail(ctx, { to, subject: `Ready to edit: ${g.title}`, text: mail.text, html: mail.html, kind: "storage", shootId: g.shootId, galleryId: g.id });
}
