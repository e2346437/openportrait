import { and, desc, eq } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { composeEmail, getEmailConfig, queueEmail } from "../domain/email.js";
import { DomainError, linkTo, type ServiceContext } from "../domain/context.js";
import { displayName } from "../domain/contacts.js";

const { gallery, contact, shootContact, emailLog, galleryVisitor, shoot } = tables;
type Gallery = typeof gallery.$inferSelect;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Recipient {
  name: string;
  email: string;
  contactId: string | null;
}

/** Who a gallery can be emailed to: the people on its shoot, then anyone who registered to view it. */
export function recipientsFor(ctx: ServiceContext, g: Gallery): Recipient[] {
  const out = new Map<string, Recipient>();
  if (g.shootId) {
    const rows = ctx.db
      .select({ id: contact.id, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email })
      .from(shootContact)
      .innerJoin(contact, eq(contact.id, shootContact.contactId))
      .where(eq(shootContact.shootId, g.shootId))
      .all();
    for (const r of rows) if (r.email && EMAIL.test(r.email)) out.set(r.email.toLowerCase(), { name: displayName(r), email: r.email, contactId: r.id });
  }
  for (const v of ctx.db.select().from(galleryVisitor).where(eq(galleryVisitor.galleryId, g.id)).all()) {
    const key = v.email.toLowerCase();
    if (!out.has(key)) out.set(key, { name: v.name || v.email, email: v.email, contactId: null });
  }
  return [...out.values()];
}

export function galleryLink(ctx: ServiceContext, g: Gallery): string {
  return linkTo(ctx, `/g/${g.slug}`);
}

/** Draft wording the owner can edit before sending. */
export function defaultMessage(ctx: ServiceContext, g: Gallery, firstName?: string): { subject: string; message: string } {
  const studio = ctx.settings.get("studio.name") || "the studio";
  const needsPassword = g.accessMode === "password";
  return {
    subject: `Your photos are ready: ${g.title}`,
    message: [`Hi${firstName ? ` ${firstName}` : ""},`, `Your gallery "${g.title}" is ready to view. You can favorite photos, send me your picks${g.downloadSize !== "none" ? " and download them" : ""} from the page.`, ...(needsPassword ? ["I'll send you the password separately."] : []), `Thank you,\n${studio}`].join("\n\n"),
  };
}

export function sentFor(ctx: ServiceContext, galleryId: string) {
  return ctx.db
    .select({ id: emailLog.id, to: emailLog.toAddress, subject: emailLog.subject, kind: emailLog.kind, status: emailLog.status, error: emailLog.error, createdAt: emailLog.createdAt, sentAt: emailLog.sentAt })
    .from(emailLog)
    .where(and(eq(emailLog.galleryId, galleryId)))
    .orderBy(desc(emailLog.createdAt))
    .limit(50)
    .all();
}

export function emailPanel(ctx: ServiceContext, g: Gallery) {
  const recipients = recipientsFor(ctx, g);
  return {
    configured: !!getEmailConfig(ctx.settings),
    live: g.status === "live",
    hasUrl: /^https?:\/\//.test(ctx.publicUrl?.() ?? ""),
    recipients,
    ...defaultMessage(ctx, g, recipients[0]?.name.split(" ")[0]),
    link: galleryLink(ctx, g),
    sent: sentFor(ctx, g.id),
  };
}

export function sendGalleryEmail(ctx: ServiceContext, g: Gallery, input: { to: string[]; subject: string; message: string }): number {
  if (!getEmailConfig(ctx.settings)) throw new DomainError("not_configured", "Set up email in Settings › Email first.", 409);
  if (g.status !== "live") throw new DomainError("not_live", "Publish the gallery before emailing the link.", 409);
  if (!/^https?:\/\//.test(ctx.publicUrl?.() ?? "")) throw new DomainError("no_url", "Set your public address in Settings › Internet first, so the link in the email works.", 409);
  const known = new Map(recipientsFor(ctx, g).map((r) => [r.email.toLowerCase(), r]));
  const studio = ctx.settings.get("studio.name") || "the studio";
  const url = galleryLink(ctx, g);
  let n = 0;
  for (const raw of new Set(input.to.map((t) => t.trim().toLowerCase()))) {
    if (!EMAIL.test(raw)) throw new DomainError("invalid", `"${raw}" isn't a valid email address.`);
    const r = known.get(raw);
    const mail = composeEmail(studio, input.message.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean), { label: "View your gallery", url });
    if (queueEmail(ctx, { to: raw, toName: r?.name ?? null, subject: input.subject, text: mail.text, html: mail.html, kind: "gallery.share", contactId: r?.contactId ?? null, shootId: g.shootId, galleryId: g.id })) n++;
  }
  return n;
}

/** Tells the studio that a client sent their favorites. Quietly does nothing when email isn't set up. */
export function notifyFavorites(ctx: ServiceContext, g: Gallery, who: string, listName: string, count: number): void {
  const to = ctx.settings.get("studio.email");
  if (!to || !getEmailConfig(ctx.settings)) return;
  const studio = ctx.settings.get("studio.name") || "the studio";
  const mail = composeEmail(studio, [`${who} sent ${count} ${count === 1 ? "photo" : "photos"} from "${listName}" in "${g.title}".`], { label: "See their picks", url: linkTo(ctx, `/studio/galleries/${g.id}?tab=favorites`) });
  queueEmail(ctx, { to, subject: `${who} sent favorites: ${g.title}`, text: mail.text, html: mail.html, kind: "gallery.favorites", shootId: g.shootId, galleryId: g.id });
}
