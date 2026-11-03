import crypto from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import type { QuestionField } from "@openportrait/db";
import { builtInMayRun } from "../automation/registry.js";
import { displayName, logActivity } from "./contacts.js";
import { DomainError, linkTo, newId, notFound, type ServiceContext } from "./context.js";
import { composeEmail, queueEmail } from "./email.js";
import { isYmd } from "./time.js";
import { cleanRich, safeRich } from "./richtext.js";

const { questionnaireTemplate, shootTypeQuestionnaire, questionnaire, shoot, shootType, contact } = tables;

export type { QuestionField };
export type Answers = Record<string, string | string[] | boolean>;
export const FIELD_TYPES = ["heading", "text", "textarea", "number", "date", "yesno", "select", "multiselect"] as const;
const MAX_FIELDS = 80;
const MAX_OPTIONS = 40;

// ---- building a form ----

/** Cleans a form from the builder: trims text, gives every question a stable id, and refuses forms a client couldn't fill in. */
export function cleanFields(input: Array<Partial<QuestionField>>): QuestionField[] {
  if (!Array.isArray(input) || input.length === 0) throw new DomainError("invalid", "Add at least one question.");
  if (input.length > MAX_FIELDS) throw new DomainError("invalid", `A form can have up to ${MAX_FIELDS} questions.`);
  const seen = new Set<string>();
  const out = input.map((raw, i): QuestionField => {
    const type = raw.type;
    if (!type || !(FIELD_TYPES as readonly string[]).includes(type)) throw new DomainError("invalid", `Question ${i + 1} has an unknown type.`);
    const label = (raw.label ?? "").trim().slice(0, 300);
    if (!label) throw new DomainError("invalid", type === "heading" ? `Section ${i + 1} needs a title.` : `Question ${i + 1} needs some text.`);
    let id = (raw.id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!id || seen.has(id)) id = `q${crypto.randomBytes(5).toString("hex")}`;
    seen.add(id);
    const f: QuestionField = { id, type, label };
    const help = raw.help?.trim().slice(0, 500);
    if (help) f.help = help;
    if (type !== "heading" && raw.required) f.required = true;
    if (type === "select" || type === "multiselect") {
      const options = [...new Set((raw.options ?? []).map((o) => String(o).trim().slice(0, 120)).filter(Boolean))];
      if (options.length < 2) throw new DomainError("invalid", `“${label}” needs at least two choices.`);
      if (options.length > MAX_OPTIONS) throw new DomainError("invalid", `“${label}” can have up to ${MAX_OPTIONS} choices.`);
      f.options = options;
    }
    return f;
  });
  if (!out.some((f) => f.type !== "heading")) throw new DomainError("invalid", "Add at least one question, not just section titles.");
  return out;
}

const q = (type: QuestionField["type"], label: string, extra: Partial<QuestionField> = {}): Partial<QuestionField> => ({ type, label, ...extra });

/** Ready-made forms to start from. Photographers copy one and change it. */
export const STARTERS: Array<{ key: string; name: string; description: string; intro: string; fields: Array<Partial<QuestionField>> }> = [
  {
    key: "wedding",
    name: "Wedding details",
    description: "People, timeline and must-have shots.",
    intro: "A few questions so I can plan your day. Answer what you can now; you can always tell me more later.",
    fields: [
      q("heading", "The two of you"),
      q("text", "Names as you'd like them said", { required: true }),
      q("text", "Best phone number on the day", { required: true }),
      q("heading", "The day"),
      q("text", "Ceremony location and start time", { required: true }),
      q("text", "Reception location and start time"),
      q("text", "Where will you each get ready?"),
      q("number", "Roughly how many guests?"),
      q("yesno", "Do you want a first look?"),
      q("textarea", "Who is in the wedding party, and who are the key family members to photograph?", { help: "Names and relationships help me spot people quickly." }),
      q("heading", "Photos"),
      q("textarea", "Must-have photos or moments"),
      q("multiselect", "Which group photos do you want?", { options: ["Both families", "Wedding party", "Parents", "Grandparents", "Siblings", "Friends"] }),
      q("textarea", "Anything I should know? Family sensitivities, accessibility needs, venue rules."),
    ],
  },
  {
    key: "portrait",
    name: "Portrait or family session",
    description: "Who is coming, the look you want, and logistics.",
    intro: "Thanks for booking. These answers help me prepare so we can spend our time making great photos.",
    fields: [
      q("text", "Who will be in the photos?", { required: true, help: "Names and ages of children." }),
      q("select", "What will you use the photos for?", { options: ["Family keepsake", "Holiday cards", "Wall art", "Social media", "Other"] }),
      q("text", "Location you have in mind"),
      q("textarea", "What style are you hoping for?", { help: "Relaxed and candid, classic and posed, bright, moody." }),
      q("textarea", "Anything that makes someone nervous, or that you'd rather skip?"),
      q("yesno", "Would you like help planning outfits?"),
    ],
  },
  {
    key: "headshot",
    name: "Headshot preferences",
    description: "How the photos will be used and the look you want.",
    intro: "Quick questions so your headshots fit how you'll use them.",
    fields: [
      q("multiselect", "Where will you use them?", { options: ["LinkedIn", "Company website", "Press or speaking", "Social media", "Printed materials"], required: true }),
      q("select", "Background", { options: ["Studio neutral", "Studio colour", "Office or environmental", "Outdoors", "Not sure yet"] }),
      q("text", "Brand or company colours"),
      q("yesno", "Is anyone else from your team booking too?"),
      q("textarea", "Anything you dislike about past headshots?"),
    ],
  },
];

// ---- templates ----

type TemplateRow = typeof questionnaireTemplate.$inferSelect;

function templateRow(ctx: ServiceContext, id: string): TemplateRow {
  const row = ctx.db.select().from(questionnaireTemplate).where(eq(questionnaireTemplate.id, id)).get();
  if (!row) throw notFound("Questionnaire");
  return row;
}

export function listTemplates(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(questionnaireTemplate)
    .where(isNull(questionnaireTemplate.archivedAt))
    .orderBy(asc(questionnaireTemplate.name))
    .all()
    .map((t) => ({
      ...t,
      questions: t.fields.filter((f) => f.type !== "heading").length,
      sent: ctx.db.select({ n: sql<number>`count(*)` }).from(questionnaire).where(eq(questionnaire.templateId, t.id)).get()?.n ?? 0,
      usedBy: ctx.db
        .select({ id: shootType.id, name: shootType.name })
        .from(shootTypeQuestionnaire)
        .innerJoin(shootType, eq(shootType.id, shootTypeQuestionnaire.shootTypeId))
        .where(eq(shootTypeQuestionnaire.templateId, t.id))
        .all(),
    }));
}

export interface TemplateInput {
  name: string;
  intro?: string | null;
  fields: Array<Partial<QuestionField>>;
}

function templateValues(input: TemplateInput) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new DomainError("invalid", "Give this questionnaire a name.");
  return { name, intro: cleanRich(input.intro).slice(0, 8000) || null, fields: cleanFields(input.fields) };
}

export function createTemplate(ctx: ServiceContext, input: TemplateInput) {
  const id = newId();
  ctx.db.insert(questionnaireTemplate).values({ id, ...templateValues(input) }).run();
  return templateRow(ctx, id);
}

export function updateTemplate(ctx: ServiceContext, id: string, input: TemplateInput) {
  templateRow(ctx, id);
  ctx.db.update(questionnaireTemplate).set({ ...templateValues(input), updatedAt: new Date() }).where(eq(questionnaireTemplate.id, id)).run();
  return templateRow(ctx, id);
}

/** A form that has been sent stays in the books: it is archived instead of removed. Sent copies are snapshots, so they're unaffected either way. */
export function deleteTemplate(ctx: ServiceContext, id: string) {
  templateRow(ctx, id);
  const used = ctx.db.select({ id: questionnaire.id }).from(questionnaire).where(eq(questionnaire.templateId, id)).get();
  ctx.db.delete(shootTypeQuestionnaire).where(eq(shootTypeQuestionnaire.templateId, id)).run();
  if (used) {
    ctx.db.update(questionnaireTemplate).set({ archivedAt: new Date() }).where(eq(questionnaireTemplate.id, id)).run();
    return { removed: false, archived: true };
  }
  ctx.db.delete(questionnaireTemplate).where(eq(questionnaireTemplate.id, id)).run();
  return { removed: true, archived: false };
}

// ---- shoot type defaults ----

export function listDefaults(ctx: ServiceContext) {
  return ctx.db.select().from(shootTypeQuestionnaire).all();
}

export function setDefault(ctx: ServiceContext, shootTypeId: string, input: { templateId: string | null; sendMode?: "manual" | "on_booking" }) {
  if (!ctx.db.select({ id: shootType.id }).from(shootType).where(eq(shootType.id, shootTypeId)).get()) throw notFound("Shoot type");
  if (!input.templateId) {
    ctx.db.delete(shootTypeQuestionnaire).where(eq(shootTypeQuestionnaire.shootTypeId, shootTypeId)).run();
    return null;
  }
  const t = templateRow(ctx, input.templateId);
  if (t.archivedAt) throw new DomainError("invalid", "That questionnaire has been removed.");
  const sendMode = input.sendMode ?? "manual";
  ctx.db
    .insert(shootTypeQuestionnaire)
    .values({ shootTypeId, templateId: t.id, sendMode })
    .onConflictDoUpdate({ target: shootTypeQuestionnaire.shootTypeId, set: { templateId: t.id, sendMode } })
    .run();
  return { shootTypeId, templateId: t.id, sendMode };
}

// ---- sent questionnaires ----

type Row = typeof questionnaire.$inferSelect;

function row(ctx: ServiceContext, id: string): Row {
  const r = ctx.db.select().from(questionnaire).where(eq(questionnaire.id, id)).get();
  if (!r) throw notFound("Questionnaire");
  return r;
}

const present = (ctx: ServiceContext, r: Row) => ({
  id: r.id,
  shootId: r.shootId,
  templateId: r.templateId,
  title: r.title,
  intro: r.intro === null ? null : safeRich(r.intro),
  fields: r.fields,
  status: r.status,
  origin: r.origin,
  answers: r.answers,
  link: linkTo(ctx, `/q/${r.token}`),
  sentAt: r.sentAt,
  viewedAt: r.viewedAt,
  submittedAt: r.submittedAt,
  createdAt: r.createdAt,
  answered: r.answers ? r.fields.filter((f) => f.type !== "heading" && hasAnswer(r.answers![f.id])).length : 0,
  questions: r.fields.filter((f) => f.type !== "heading").length,
});

export function listForShoot(ctx: ServiceContext, shootId: string) {
  return ctx.db.select().from(questionnaire).where(eq(questionnaire.shootId, shootId)).orderBy(desc(questionnaire.createdAt)).all().map((r) => present(ctx, r));
}

export function getQuestionnaire(ctx: ServiceContext, id: string) {
  return present(ctx, row(ctx, id));
}

/** Makes a questionnaire for a shoot from a template. With `send`, the client is emailed the link straight away. */
export function createForShoot(ctx: ServiceContext, shootId: string, templateId: string, opts: { send?: boolean; origin?: "manual" | "auto" } = {}) {
  const s = ctx.db.select().from(shoot).where(eq(shoot.id, shootId)).get();
  if (!s) throw notFound("Shoot");
  const t = templateRow(ctx, templateId);
  if (t.archivedAt) throw new DomainError("invalid", "That questionnaire has been removed.");
  const id = newId();
  ctx.db
    .insert(questionnaire)
    .values({ id, shootId, contactId: s.primaryContactId, templateId: t.id, title: t.name, intro: t.intro, fields: t.fields, token: crypto.randomBytes(24).toString("base64url"), origin: opts.origin ?? "manual" })
    .run();
  if (opts.send) return send(ctx, id);
  return present(ctx, row(ctx, id));
}

/** Emails the client their link (or sends it again). Returns whether an email actually went into the queue. */
export function send(ctx: ServiceContext, id: string) {
  const r = row(ctx, id);
  if (r.status === "submitted") throw new DomainError("invalid", "The client has already answered this one. Reopen it to ask them again.");
  const c = ctx.db.select().from(contact).where(eq(contact.id, r.contactId)).get();
  if (!c?.email) throw new DomainError("no_email", "Add an email address to this contact before sending.");
  const first = r.status === "draft";
  ctx.db.update(questionnaire).set({ status: "sent", sentAt: new Date() }).where(eq(questionnaire.id, id)).run();
  const studio = ctx.settings.get("studio.name") || "the studio";
  const mail = composeEmail(
    studio,
    [`Hi ${c.firstName || "there"},`, `${first ? "Please take a few minutes to fill in" : "A reminder to fill in"} “${r.title}”. It helps me prepare for your session.`, "You can answer from your phone, and it only takes a few minutes."],
    { label: "Answer the questions", url: linkTo(ctx, `/q/${r.token}`) },
  );
  const emailed = !!queueEmail(ctx, { to: c.email, toName: displayName(c), subject: `${r.title}: a few questions`, text: mail.text, html: mail.html, kind: "questionnaire.sent", contactId: c.id, shootId: r.shootId });
  logActivity(ctx, { contactId: c.id, shootId: r.shootId, kind: "questionnaire.sent", summary: `${first ? "Sent" : "Re-sent"} questionnaire “${r.title}”${r.origin === "auto" && first ? " automatically" : ""}` });
  return { ...present(ctx, row(ctx, id)), emailed };
}

/** Lets the client answer again, for example after the owner asks for a correction. */
export function reopen(ctx: ServiceContext, id: string) {
  const r = row(ctx, id);
  if (r.status !== "submitted") return present(ctx, r);
  ctx.db.update(questionnaire).set({ status: "sent", submittedAt: null }).where(eq(questionnaire.id, id)).run();
  return present(ctx, row(ctx, id));
}

export function deleteQuestionnaire(ctx: ServiceContext, id: string) {
  const r = row(ctx, id);
  if (r.status === "submitted") throw new DomainError("invalid", "The client's answers are saved on the shoot, so this can't be removed.");
  ctx.db.delete(questionnaire).where(eq(questionnaire.id, id)).run();
  return { removed: true };
}

// ---- automatic sending ----

/** The default form for a shoot's type, when it should go out by itself and hasn't yet. */
function pendingAuto(ctx: ServiceContext, shootId: string) {
  const s = ctx.db.select().from(shoot).where(eq(shoot.id, shootId)).get();
  if (!s) return null;
  const rule = ctx.db.select().from(shootTypeQuestionnaire).where(eq(shootTypeQuestionnaire.shootTypeId, s.shootTypeId)).get();
  if (!rule || rule.sendMode !== "on_booking") return null;
  const t = ctx.db.select().from(questionnaireTemplate).where(eq(questionnaireTemplate.id, rule.templateId)).get();
  if (!t || t.archivedAt) return null;
  if (ctx.db.select({ id: questionnaire.id }).from(questionnaire).where(and(eq(questionnaire.shootId, shootId), eq(questionnaire.templateId, t.id))).get()) return null;
  return { shoot: s, template: t };
}

/**
 * Called when a shoot is booked. If its type has a form set to go out on booking, the client gets it now.
 * Never throws: a missing email address or mail setup must not stop a booking. When a connected AI owns this
 * decision, the built-in rule stays quiet and the shoot shows up in the work queue instead.
 */
export function autoSendForShoot(ctx: ServiceContext, shootId: string): void {
  try {
    if (!builtInMayRun(ctx.settings, "questionnaire-send")) return;
    const p = pendingAuto(ctx, shootId);
    if (!p) return;
    const c = ctx.db.select().from(contact).where(eq(contact.id, p.shoot.primaryContactId)).get();
    if (!c?.email) {
      // Keep it as a draft on the shoot so the owner sees what is waiting for an email address.
      createForShoot(ctx, shootId, p.template.id, { origin: "auto" });
      return;
    }
    createForShoot(ctx, shootId, p.template.id, { send: true, origin: "auto" });
  } catch {
    /* the shoot is saved either way */
  }
}

/** Shoots whose type has an automatic form that hasn't been made yet. Used for the AI work queue. */
export function awaitingAutoSend(ctx: ServiceContext) {
  const rules = ctx.db.select().from(shootTypeQuestionnaire).where(eq(shootTypeQuestionnaire.sendMode, "on_booking")).all();
  if (!rules.length) return [];
  return ctx.db
    .select({ id: shoot.id, subject: shoot.subject, createdAt: shoot.createdAt, shootTypeId: shoot.shootTypeId })
    .from(shoot)
    .where(sql`${shoot.status} not in ('complete', 'cancelled', 'delivered')`)
    .orderBy(asc(shoot.createdAt))
    .limit(200)
    .all()
    .filter((s) => pendingAuto(ctx, s.id) !== null)
    .slice(0, 25);
}

// ---- the client's page ----

function byToken(ctx: ServiceContext, token: string): Row {
  const r = ctx.db.select().from(questionnaire).where(eq(questionnaire.token, token)).get();
  // A draft has never been sent, so its link does not work yet.
  if (!r || r.status === "draft") throw new DomainError("not_found", "This questionnaire isn't available.", 404);
  return r;
}

export function publicView(ctx: ServiceContext, token: string) {
  const r = byToken(ctx, token);
  if (!r.viewedAt) ctx.db.update(questionnaire).set({ viewedAt: new Date() }).where(eq(questionnaire.id, r.id)).run();
  return {
    studioName: ctx.settings.get("studio.name") ?? "",
    title: r.title,
    intro: r.intro === null ? null : safeRich(r.intro),
    fields: r.fields,
    status: r.status === "submitted" ? ("submitted" as const) : ("open" as const),
    answers: r.status === "submitted" ? r.answers : null,
  };
}

const hasAnswer = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "boolean" ? true : typeof v === "string" ? v.trim() !== "" : false);

/** Checks the client's answers against the form they were sent, and keeps only what the form asks for. */
export function cleanAnswers(fields: QuestionField[], raw: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const f of fields) {
    if (f.type === "heading") continue;
    const v = raw[f.id];
    const missing = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (missing) {
      if (f.required) throw new DomainError("invalid", `Please answer “${f.label}”.`);
      continue;
    }
    const bad = () => new DomainError("invalid", `That answer to “${f.label}” isn't valid.`);
    switch (f.type) {
      case "text":
      case "textarea": {
        if (typeof v !== "string") throw bad();
        const s = v.trim();
        if (s.length > (f.type === "text" ? 500 : 8000)) throw new DomainError("invalid", `Your answer to “${f.label}” is too long.`);
        if (s) out[f.id] = s;
        else if (f.required) throw new DomainError("invalid", `Please answer “${f.label}”.`);
        break;
      }
      case "number": {
        const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
        if (!s || !Number.isFinite(Number(s)) || s.length > 40) throw new DomainError("invalid", `Enter a number for “${f.label}”.`);
        out[f.id] = s;
        break;
      }
      case "date":
        if (typeof v !== "string" || !isYmd(v)) throw new DomainError("invalid", `Enter a date for “${f.label}”.`);
        out[f.id] = v;
        break;
      case "yesno":
        if (typeof v !== "boolean") throw bad();
        out[f.id] = v;
        break;
      case "select":
        if (typeof v !== "string" || !f.options?.includes(v)) throw bad();
        out[f.id] = v;
        break;
      case "multiselect": {
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !f.options?.includes(x))) throw bad();
        out[f.id] = [...new Set(v as string[])];
        break;
      }
    }
  }
  return out;
}

export function submit(ctx: ServiceContext, token: string, raw: Record<string, unknown>) {
  const r = byToken(ctx, token);
  if (r.status === "submitted") throw new DomainError("conflict", "Your answers have already been sent. If you need to change something, reply to the email and ask for a new link.", 409);
  const answers = cleanAnswers(r.fields, raw);
  ctx.db.update(questionnaire).set({ status: "submitted", answers, submittedAt: new Date() }).where(eq(questionnaire.id, r.id)).run();
  const c = ctx.db.select().from(contact).where(eq(contact.id, r.contactId)).get();
  const s = ctx.db.select({ subject: shoot.subject }).from(shoot).where(eq(shoot.id, r.shootId)).get();
  if (c) logActivity(ctx, { contactId: c.id, shootId: r.shootId, kind: "questionnaire.submitted", summary: `${displayName(c)} answered “${r.title}”` });
  const owner = ctx.settings.get("studio.email");
  if (owner) {
    const studio = ctx.settings.get("studio.name") || "OpenPortrait";
    const mail = composeEmail(studio, [`${c ? displayName(c) : "A client"} answered “${r.title}”${s ? ` for ${s.subject}` : ""}.`], { label: "See their answers", url: linkTo(ctx, `/studio/shoots/${r.shootId}`) });
    queueEmail(ctx, { to: owner, subject: `${c ? displayName(c) : "A client"} answered ${r.title}`, text: mail.text, html: mail.html, kind: "questionnaire.notice" });
  }
  return { ok: true as const };
}
