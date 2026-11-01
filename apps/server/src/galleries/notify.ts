import { and, eq, inArray } from "drizzle-orm";
import { tables } from "@openportrait/db";
import type { AppContext } from "../app.js";
import { fill, renderEmail, templateFor } from "../email/templates.js";
import { displayName } from "../domain/contacts.js";

const { gallery, shoot, shootContact, contact, activity, favoriteList } = tables;
type Gallery = typeof gallery.$inferSelect;

export interface Recipient {
  contactId: string | null;
  name: string;
  email: string;
}

/** The people on this gallery's shoot who have an email address, primary contact first. */
export function galleryRecipients(ctx: AppContext, g: Pick<Gallery, "shootId">): Recipient[] {
  if (!g.shootId) return [];
  const s = ctx.db.select().from(shoot).where(eq(shoot.id, g.shootId)).get();
  if (!s) return [];
  const extra = ctx.db.select({ id: shootContact.contactId }).from(shootContact).where(eq(shootContact.shootId, s.id)).all().map((r) => r.id);
  const ids = [s.primaryContactId, ...extra.filter((id) => id !== s.primaryContactId)];
  const rows = ctx.db.select().from(contact).where(inArray(contact.id, ids)).all();
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c && !!c.email && !c.archivedAt)
    .map((c) => ({ contactId: c.id, name: displayName(c), email: c.email! }));
}

function logActivity(ctx: AppContext, g: Gallery, contactId: string | null, kind: string, summary: string) {
  const who = contactId ?? (g.shootId ? ctx.db.select({ id: shoot.primaryContactId }).from(shoot).where(eq(shoot.id, g.shootId)).get()?.id : undefined);
  if (who) ctx.db.insert(activity).values({ contactId: who, shootId: g.shootId, kind, summary }).run();
}

/** "Your photos are ready": one email per recipient, so each sees only their own name. */
export async function sendGalleryReady(ctx: AppContext, g: Gallery, to: Recipient[], note: string, actorId: string | null) {
  const studioName = ctx.settings.get("studio.name") ?? "";
  const link = `${ctx.publicUrl()}/g/${g.slug}`;
  const t = templateFor(ctx.settings, "galleryReady");
  const logo = ctx.settings.get("studio.logoVersion") ? `${ctx.publicUrl()}/api/branding/logo?v=${ctx.settings.get("studio.logoVersion")}` : null;
  const results = [];
  for (const r of to) {
    const first = r.name.split(/\s+/)[0] || "there";
    const values = { client_name: first, gallery_title: g.title, gallery_link: link, studio_name: studioName, message: note.trim() };
    const body = fill(t.body, values);
    const mail = renderEmail({ studioName, body, button: { label: "View your gallery", url: link }, logoUrl: logo, footer: g.accessMode === "password" ? "This gallery is protected. Your photographer will send you the password separately." : undefined });
    const res = await ctx.mailer.send({ kind: "gallery.ready", to: r.email, toName: r.name, subject: fill(t.subject, values), text: mail.text, html: mail.html, contactId: r.contactId, shootId: g.shootId, galleryId: g.id });
    if (res.ok) logActivity(ctx, g, r.contactId, "email.sent", `Emailed the link to “${g.title}” to ${r.email}`);
    results.push({ email: r.email, ...res });
  }
  void actorId;
  return results;
}

/** Tells the studio a client sent a favorites list. Best effort: a mail problem never blocks the client. */
export async function notifyFavoritesSubmitted(ctx: AppContext, g: Gallery, listId: string, clientEmail: string, count: number) {
  if (ctx.settings.get("galleries.notifyOnSubmit") === false) return;
  const to = ctx.settings.get("studio.email");
  if (!to || !ctx.mailer.configured()) return;
  const list = ctx.db.select().from(favoriteList).where(and(eq(favoriteList.id, listId), eq(favoriteList.galleryId, g.id))).get();
  const studioName = ctx.settings.get("studio.name") ?? "";
  const base = ctx.publicUrl();
  const link = `${base}/studio/galleries/${g.id}?tab=favorites`;
  const body = `${clientEmail} sent ${count === 1 ? "1 favorite" : `${count} favorites`} from “${g.title}”${list ? ` (${list.name})` : ""}.\n\nOpen the gallery to see their picks and copy the file names.`;
  const mail = renderEmail({ studioName, body, button: /^https?:\/\//.test(base) ? { label: "See their favorites", url: link } : undefined });
  const res = await ctx.mailer.send({ kind: "gallery.favorites", to, subject: `${clientEmail} sent ${count === 1 ? "a favorite" : `${count} favorites`} from ${g.title}`, text: mail.text, html: mail.html, shootId: g.shootId, galleryId: g.id });
  if (res.ok) logActivity(ctx, g, null, "gallery.favorites", `${clientEmail} sent ${count} favorites from “${g.title}”`);
}
