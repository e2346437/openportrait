import { and, asc, isNull } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { composeEmail, queueEmail } from "./email.js";
import { DomainError, linkTo, type ServiceContext } from "./context.js";
import { displayName } from "./contacts.js";
import { createLead } from "./leads.js";

const { shootType } = tables;

export const DEFAULT_INTRO = "Tell me a little about what you have in mind and I'll get back to you soon.";
export const DEFAULT_THANKS = "Thank you. Your message is in, and I'll reply by email as soon as I can.";

/** What the public inquiry page needs to draw itself. Nothing private. */
export function publicFormInfo(ctx: ServiceContext) {
  const types = ctx.db.select({ id: shootType.id, name: shootType.name }).from(shootType).where(isNull(shootType.archivedAt)).orderBy(asc(shootType.position)).all();
  return {
    enabled: ctx.settings.get("inquiry.enabled") ?? true,
    studioName: ctx.settings.get("studio.name") ?? "",
    intro: ctx.settings.get("inquiry.intro") || DEFAULT_INTRO,
    thanks: ctx.settings.get("inquiry.thanks") || DEFAULT_THANKS,
    shootTypes: types,
  };
}

export function inquirySettings(ctx: ServiceContext) {
  return {
    enabled: ctx.settings.get("inquiry.enabled") ?? true,
    intro: ctx.settings.get("inquiry.intro") ?? "",
    thanks: ctx.settings.get("inquiry.thanks") ?? "",
    notify: ctx.settings.get("inquiry.notify") ?? true,
    introDefault: DEFAULT_INTRO,
    thanksDefault: DEFAULT_THANKS,
    pageUrl: linkTo(ctx, "/inquire"),
  };
}

export function saveInquirySettings(ctx: ServiceContext, input: { enabled?: boolean; intro?: string; thanks?: string; notify?: boolean }) {
  const s = ctx.settings;
  if (input.enabled !== undefined) s.set("inquiry.enabled", input.enabled);
  if (input.intro !== undefined) s.set("inquiry.intro", input.intro.trim().slice(0, 1000));
  if (input.thanks !== undefined) s.set("inquiry.thanks", input.thanks.trim().slice(0, 1000));
  if (input.notify !== undefined) s.set("inquiry.notify", input.notify);
  return inquirySettings(ctx);
}

export interface InquiryInput {
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
  shootTypeId?: string;
  eventDate?: string;
  message?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A visitor sends the form. Creates (or reuses) the contact, files an inquiry, and emails both sides. */
export function submitInquiry(ctx: ServiceContext, input: InquiryInput) {
  if (!(ctx.settings.get("inquiry.enabled") ?? true)) throw new DomainError("closed", "This form isn't taking inquiries right now.", 403);
  const firstName = input.firstName.trim();
  const email = input.email.trim().toLowerCase();
  if (!firstName) throw new DomainError("invalid", "Please enter your name.");
  if (!EMAIL.test(email) || email.length > 254) throw new DomainError("invalid", "Please enter a valid email address so I can reply.");
  const known = input.shootTypeId && ctx.db.select({ id: shootType.id }).from(shootType).where(and(isNull(shootType.archivedAt))).all().some((t) => t.id === input.shootTypeId);
  const res = createLead(ctx, {
    contact: { firstName, lastName: input.lastName?.trim() ?? "", email, phone: input.phone?.trim() || null, source: "Website form" },
    shootTypeId: known ? input.shootTypeId : null,
    source: "Website form",
    message: input.message,
    eventDate: input.eventDate || null,
  });
  const studio = ctx.settings.get("studio.name") || "the studio";
  const name = displayName({ firstName, lastName: input.lastName ?? "", email });
  const thanks = ctx.settings.get("inquiry.thanks") || DEFAULT_THANKS;
  const toClient = composeEmail(studio, [`Hi ${firstName},`, thanks]);
  queueEmail(ctx, { to: email, toName: name, subject: `We got your message, ${firstName}`, text: toClient.text, html: toClient.html, kind: "inquiry.thanks", contactId: res.lead.contactId });
  const owner = ctx.settings.get("studio.email");
  if (owner && (ctx.settings.get("inquiry.notify") ?? true)) {
    const mail = composeEmail(studio, [`New inquiry from ${name} (${email}).`, input.message ? `Their message:\n${input.message.trim().slice(0, 2000)}` : "They didn't leave a message."], { label: "Open the inquiry", url: linkTo(ctx, `/studio/leads/${res.lead.id}`) });
    queueEmail(ctx, { to: owner, subject: `New inquiry: ${name}`, text: mail.text, html: mail.html, kind: "inquiry.notify" });
  }
  return { ok: true as const };
}
