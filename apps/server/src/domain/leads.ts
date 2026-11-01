import { asc, desc, eq, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { createContact, displayName, findByEmail, logActivity, type ContactInput } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { createShoot, type EventInput } from "./shoots.js";

const { lead, leadStage, contact, shootType, note } = tables;

const CLOSED_COLUMN_LIMIT = 25;

const leadSelect = {
  id: lead.id,
  contactId: lead.contactId,
  stageId: lead.stageId,
  shootTypeId: lead.shootTypeId,
  shootType: shootType.name,
  source: lead.source,
  eventDate: lead.eventDate,
  createdAt: lead.createdAt,
  firstName: contact.firstName,
  lastName: contact.lastName,
  company: contact.company,
  email: contact.email,
  convertedShootId: lead.convertedShootId,
};

function card(r: { firstName: string; lastName: string; company: string | null; email: string | null } & Record<string, unknown>) {
  const { firstName, lastName, company, email, ...rest } = r;
  return { ...rest, name: displayName({ firstName, lastName, company, email }), email };
}

/** The pipeline: every stage with its leads. Won and lost columns show only the most recent. */
export function board(ctx: ServiceContext) {
  const stages = ctx.db.select().from(leadStage).orderBy(asc(leadStage.position)).all();
  return stages.map((stage) => {
    const rows = ctx.db
      .select(leadSelect)
      .from(lead)
      .innerJoin(contact, eq(contact.id, lead.contactId))
      .leftJoin(shootType, eq(shootType.id, lead.shootTypeId))
      .where(eq(lead.stageId, stage.id))
      .orderBy(desc(lead.createdAt))
      .limit(stage.kind === "open" ? 500 : CLOSED_COLUMN_LIMIT)
      .all();
    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(lead).where(eq(lead.stageId, stage.id)).get()?.n ?? 0;
    return { ...stage, total, leads: rows.map(card) };
  });
}

function leadRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(lead).where(eq(lead.id, id)).get();
  if (!row) throw notFound("Lead");
  return row;
}

function stageRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(leadStage).where(eq(leadStage.id, id)).get();
  if (!row) throw notFound("Stage");
  return row;
}

export interface LeadInput {
  /** An existing contact, or the details of a new one. A matching email reuses the existing person. */
  contactId?: string;
  contact?: ContactInput;
  shootTypeId?: string | null;
  source?: string | null;
  message?: string | null;
  eventDate?: string | null;
  stageId?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createLead(ctx: ServiceContext, input: LeadInput) {
  let contactId = input.contactId;
  let reusedContact = false;
  if (!contactId) {
    if (!input.contact) throw new DomainError("invalid", "Choose a contact or enter their details.");
    const existing = input.contact.email ? findByEmail(ctx, input.contact.email) : null;
    if (existing) {
      contactId = existing.id;
      reusedContact = true;
    } else {
      contactId = createContact(ctx, input.contact).id;
    }
  } else if (!ctx.db.select().from(contact).where(eq(contact.id, contactId)).get()) {
    throw notFound("Contact");
  }
  const stage = input.stageId
    ? stageRow(ctx, input.stageId)
    : ctx.db.select().from(leadStage).where(eq(leadStage.kind, "open")).orderBy(asc(leadStage.position)).get();
  if (!stage || stage.kind !== "open") throw new DomainError("invalid", "A new lead has to start in an open stage.");
  if (input.eventDate && !DATE.test(input.eventDate)) throw new DomainError("invalid", "Enter the date as YYYY-MM-DD.");
  if (input.shootTypeId && !ctx.db.select().from(shootType).where(eq(shootType.id, input.shootTypeId)).get()) throw new DomainError("invalid", "Choose a shoot type.");
  const id = newId();
  ctx.db
    .insert(lead)
    .values({ id, contactId, stageId: stage.id, shootTypeId: input.shootTypeId || null, source: input.source?.trim() || null, message: input.message?.trim().slice(0, 10_000) || null, eventDate: input.eventDate || null })
    .run();
  logActivity(ctx, { contactId, leadId: id, kind: "lead.created", summary: input.source ? `New inquiry from ${input.source}` : "New inquiry" });
  return { lead: getLead(ctx, id), reusedContact };
}

export function getLead(ctx: ServiceContext, id: string) {
  const row = leadRow(ctx, id);
  const c = ctx.db.select().from(contact).where(eq(contact.id, row.contactId)).get()!;
  const stage = stageRow(ctx, row.stageId);
  const type = row.shootTypeId ? ctx.db.select().from(shootType).where(eq(shootType.id, row.shootTypeId)).get() : null;
  const notes = ctx.db.select().from(note).where(eq(note.leadId, id)).orderBy(desc(note.createdAt)).all();
  const events = ctx.db.select().from(tables.activity).where(eq(tables.activity.leadId, id)).orderBy(desc(tables.activity.at)).all();
  return {
    ...row,
    stage,
    shootType: type ?? null,
    contact: { id: c.id, name: displayName(c), email: c.email, phone: c.phone },
    notes,
    activity: events.map((a) => ({ id: a.id, at: a.at, kind: a.kind, text: a.summary })),
  };
}

export function updateLead(ctx: ServiceContext, id: string, input: { shootTypeId?: string | null; source?: string | null; message?: string | null; eventDate?: string | null }) {
  leadRow(ctx, id);
  if (input.eventDate && !DATE.test(input.eventDate)) throw new DomainError("invalid", "Enter the date as YYYY-MM-DD.");
  if (input.shootTypeId && !ctx.db.select().from(shootType).where(eq(shootType.id, input.shootTypeId)).get()) throw new DomainError("invalid", "Choose a shoot type.");
  const patch: Partial<typeof lead.$inferInsert> = {};
  if (input.shootTypeId !== undefined) patch.shootTypeId = input.shootTypeId || null;
  if (input.source !== undefined) patch.source = input.source?.trim() || null;
  if (input.message !== undefined) patch.message = input.message?.trim() || null;
  if (input.eventDate !== undefined) patch.eventDate = input.eventDate || null;
  ctx.db.update(lead).set({ ...patch, updatedAt: new Date() }).where(eq(lead.id, id)).run();
  return getLead(ctx, id);
}

/**
 * Moves a lead to another open stage, or reopens a lost one. Winning goes through `convertLead`
 * (so a won lead always has its shoot) and losing through `loseLead`.
 */
export function moveLead(ctx: ServiceContext, id: string, stageId: string) {
  const row = leadRow(ctx, id);
  const stage = stageRow(ctx, stageId);
  if (stage.kind === "won") throw new DomainError("use_convert", "Book the shoot to win this lead.");
  if (stage.kind === "lost") return loseLead(ctx, id);
  if (row.convertedShootId) throw new DomainError("converted", "This lead already became a shoot, so it can't go back to the pipeline.");
  if (row.stageId === stageId) return getLead(ctx, id);
  ctx.db.update(lead).set({ stageId, closedAt: null, lostReason: null, updatedAt: new Date() }).where(eq(lead.id, id)).run();
  logActivity(ctx, { contactId: row.contactId, leadId: id, kind: "lead.stage", summary: `Moved to ${stage.name}` });
  return getLead(ctx, id);
}

export function loseLead(ctx: ServiceContext, id: string, reason?: string) {
  const row = leadRow(ctx, id);
  if (row.convertedShootId) throw new DomainError("converted", "This lead already became a shoot.");
  const stage = ctx.db.select().from(leadStage).where(eq(leadStage.kind, "lost")).orderBy(asc(leadStage.position)).get();
  if (!stage) throw new DomainError("invalid", "There is no Lost stage.");
  ctx.db.update(lead).set({ stageId: stage.id, lostReason: reason?.trim() || null, closedAt: new Date(), updatedAt: new Date() }).where(eq(lead.id, id)).run();
  logActivity(ctx, { contactId: row.contactId, leadId: id, kind: "lead.lost", summary: reason?.trim() ? `Lost: ${reason.trim()}` : "Marked lost" });
  return getLead(ctx, id);
}

export interface ConvertInput {
  shootTypeId?: string;
  subject?: string;
  events?: EventInput[];
}

/** Turns a lead into a booked shoot, creating its folder if the shoot has a date. */
export function convertLead(ctx: ServiceContext, id: string, input: ConvertInput = {}) {
  const row = leadRow(ctx, id);
  if (row.convertedShootId) throw new DomainError("converted", "This lead was already booked.");
  const shootTypeId = input.shootTypeId ?? row.shootTypeId;
  if (!shootTypeId) throw new DomainError("invalid", "Choose a shoot type for the booking.");
  const won = ctx.db.select().from(leadStage).where(eq(leadStage.kind, "won")).orderBy(asc(leadStage.position)).get();
  if (!won) throw new DomainError("invalid", "There is no Booked stage.");
  const result = createShoot(ctx, { primaryContactId: row.contactId, shootTypeId, subject: input.subject, leadId: id, events: input.events });
  ctx.db.update(lead).set({ stageId: won.id, convertedShootId: result.shoot.id, closedAt: new Date(), updatedAt: new Date() }).where(eq(lead.id, id)).run();
  logActivity(ctx, { contactId: row.contactId, leadId: id, shootId: result.shoot.id, kind: "lead.won", summary: "Booked" });
  return { lead: getLead(ctx, id), shoot: result.shoot, folderError: result.folderError };
}

export function openLeadCount(ctx: ServiceContext): number {
  return ctx.db.select({ n: sql<number>`count(*)` }).from(lead).innerJoin(leadStage, eq(leadStage.id, lead.stageId)).where(eq(leadStage.kind, "open")).get()?.n ?? 0;
}
