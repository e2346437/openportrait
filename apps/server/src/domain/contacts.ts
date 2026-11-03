import { and, asc, desc, eq, inArray, isNull, like, or, sql, count } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { NOTE_MAX, cleanRich, safeRich } from "./richtext.js";

const { contact, tag, contactTag, note, activity, lead, shoot, shootType, leadStage, household } = tables;

export interface ContactInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  source?: string | null;
}

const blankToNull = (v: string | null | undefined) => {
  if (v === undefined) return undefined;
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

function clean(input: ContactInput) {
  const out: Record<string, string | null | undefined> = {};
  for (const key of ["email", "phone", "company", "addressLine1", "addressLine2", "city", "region", "postalCode", "country", "source"] as const) {
    out[key] = blankToNull(input[key]);
  }
  if (out.email) out.email = out.email.toLowerCase();
  if (input.firstName !== undefined) out.firstName = input.firstName.trim();
  if (input.lastName !== undefined) out.lastName = input.lastName.trim();
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<typeof contact.$inferInsert>;
}

export function displayName(c: { firstName: string; lastName: string; company?: string | null; email?: string | null }): string {
  const name = `${c.firstName} ${c.lastName}`.trim();
  return name || c.company || c.email || "Unnamed contact";
}

export function logActivity(ctx: ServiceContext, a: { contactId: string; kind: string; summary: string; leadId?: string | null; shootId?: string | null; detail?: unknown }) {
  ctx.db
    .insert(activity)
    .values({ contactId: a.contactId, kind: a.kind, summary: a.summary, leadId: a.leadId ?? null, shootId: a.shootId ?? null, detail: a.detail ?? null, actorId: ctx.actorId })
    .run();
}

export function createContact(ctx: ServiceContext, input: ContactInput) {
  const values = clean(input);
  if (!(values.firstName || values.lastName || values.company || values.email)) {
    throw new DomainError("invalid", "Add a name, company or email so you can find this contact later.");
  }
  const id = newId();
  ctx.db.insert(contact).values({ firstName: "", lastName: "", ...values, id }).run();
  const created = getContactRow(ctx, id);
  logActivity(ctx, { contactId: id, kind: "contact.created", summary: "Contact added" });
  return created;
}

function getContactRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(contact).where(eq(contact.id, id)).get();
  if (!row) throw notFound("Contact");
  return row;
}

export function updateContact(ctx: ServiceContext, id: string, input: ContactInput) {
  const current = getContactRow(ctx, id);
  const values = clean(input);
  const next = { ...current, ...values };
  if (!(next.firstName || next.lastName || next.company || next.email)) {
    throw new DomainError("invalid", "A contact needs a name, company or email.");
  }
  ctx.db.update(contact).set({ ...values, updatedAt: new Date() }).where(eq(contact.id, id)).run();
  return getContactRow(ctx, id);
}

export function setArchived(ctx: ServiceContext, id: string, archived: boolean) {
  getContactRow(ctx, id);
  ctx.db.update(contact).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(contact.id, id)).run();
  logActivity(ctx, { contactId: id, kind: archived ? "contact.archived" : "contact.restored", summary: archived ? "Contact archived" : "Contact restored" });
  return getContactRow(ctx, id);
}

export interface ContactQuery {
  q?: string;
  tag?: string;
  archived?: boolean;
  limit?: number;
  offset?: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function listContacts(ctx: ServiceContext, query: ContactQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const conditions = [query.archived ? sql`${contact.archivedAt} is not null` : isNull(contact.archivedAt)];
  const q = query.q?.trim();
  if (q) {
    // Every word has to match somewhere, so "jane smith" finds Jane Smith and "smith jane@" works too.
    for (const word of q.split(/\s+/).slice(0, 6)) {
      const pattern = `%${escapeLike(word)}%`;
      conditions.push(
        or(
          sql`${contact.firstName} like ${pattern} escape '\\'`,
          sql`${contact.lastName} like ${pattern} escape '\\'`,
          sql`${contact.email} like ${pattern} escape '\\'`,
          sql`${contact.phone} like ${pattern} escape '\\'`,
          sql`${contact.company} like ${pattern} escape '\\'`,
        )!,
      );
    }
  }
  if (query.tag) {
    conditions.push(sql`${contact.id} in (select ${contactTag.contactId} from ${contactTag} join ${tag} on ${tag.id} = ${contactTag.tagId} where ${tag.name} = ${query.tag} collate nocase)`);
  }
  const where = and(...conditions);
  const total = ctx.db.select({ n: count() }).from(contact).where(where).get()?.n ?? 0;
  const rows = ctx.db.select().from(contact).where(where).orderBy(asc(sql`lower(${contact.lastName})`), asc(sql`lower(${contact.firstName})`)).limit(limit).offset(offset).all();
  const tagsByContact = tagsFor(ctx, rows.map((r) => r.id));
  return { total, items: rows.map((r) => ({ ...r, name: displayName(r), tags: tagsByContact.get(r.id) ?? [] })) };
}

function tagsFor(ctx: ServiceContext, ids: string[]) {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const rows = ctx.db
    .select({ contactId: contactTag.contactId, name: tag.name })
    .from(contactTag)
    .innerJoin(tag, eq(tag.id, contactTag.tagId))
    .where(inArray(contactTag.contactId, ids))
    .orderBy(asc(sql`lower(${tag.name})`))
    .all();
  for (const r of rows) map.set(r.contactId, [...(map.get(r.contactId) ?? []), r.name]);
  return map;
}

export function listTags(ctx: ServiceContext) {
  return ctx.db
    .select({ name: tag.name, contacts: count(contactTag.contactId) })
    .from(tag)
    .leftJoin(contactTag, eq(contactTag.tagId, tag.id))
    .groupBy(tag.id)
    .orderBy(asc(sql`lower(${tag.name})`))
    .all();
}

/** Replaces a contact's tags with exactly these names, creating any that don't exist yet. */
export function setContactTags(ctx: ServiceContext, contactId: string, names: string[]) {
  getContactRow(ctx, contactId);
  const byLower = new Map<string, string>();
  for (const raw of names) {
    const n = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (n && !byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n); // first spelling wins
  }
  const wanted = [...byLower.values()];
  ctx.db.transaction((tx) => {
    const ids: string[] = [];
    for (const name of wanted) {
      const existing = tx.select().from(tag).where(sql`${tag.name} = ${name} collate nocase`).get();
      if (existing) ids.push(existing.id);
      else {
        const id = newId();
        tx.insert(tag).values({ id, name }).run();
        ids.push(id);
      }
    }
    tx.delete(contactTag).where(eq(contactTag.contactId, contactId)).run();
    if (ids.length) tx.insert(contactTag).values(ids.map((tagId) => ({ contactId, tagId }))).run();
  });
  return tagsFor(ctx, [contactId]).get(contactId) ?? [];
}

export function addNote(ctx: ServiceContext, contactId: string, body: string, link: { leadId?: string; shootId?: string } = {}) {
  getContactRow(ctx, contactId);
  const text = cleanRich(body);
  if (!text) throw new DomainError("invalid", "Write something to save.");
  if (text.length > NOTE_MAX) throw new DomainError("invalid", "That note is too long. Split it into two.");
  const id = newId();
  ctx.db.insert(note).values({ id, contactId, body: text, authorId: ctx.actorId, leadId: link.leadId ?? null, shootId: link.shootId ?? null }).run();
  return ctx.db.select().from(note).where(eq(note.id, id)).get()!;
}

export function deleteNote(ctx: ServiceContext, noteId: string) {
  const row = ctx.db.select().from(note).where(eq(note.id, noteId)).get();
  if (!row) throw notFound("Note");
  ctx.db.delete(note).where(eq(note.id, noteId)).run();
}

/** Notes and activity merged into one newest-first timeline. */
export function timeline(ctx: ServiceContext, contactId: string, limit = 100) {
  const notes = ctx.db
    .select({ id: note.id, at: note.createdAt, body: note.body, authorId: note.authorId, authorName: tables.user.name, leadId: note.leadId, shootId: note.shootId })
    .from(note)
    .leftJoin(tables.user, eq(tables.user.id, note.authorId))
    .where(eq(note.contactId, contactId))
    .orderBy(desc(note.createdAt))
    .limit(limit)
    .all()
    .map((n) => ({ type: "note" as const, id: n.id, at: n.at, text: safeRich(n.body), by: n.authorName ?? null, leadId: n.leadId, shootId: n.shootId }));
  const events = ctx.db
    .select({ id: activity.id, at: activity.at, kind: activity.kind, summary: activity.summary, leadId: activity.leadId, shootId: activity.shootId, actorName: tables.user.name })
    .from(activity)
    .leftJoin(tables.user, eq(tables.user.id, activity.actorId))
    .where(eq(activity.contactId, contactId))
    .orderBy(desc(activity.at))
    .limit(limit)
    .all()
    .map((a) => ({ type: "activity" as const, id: String(a.id), at: a.at, kind: a.kind, text: a.summary, by: a.actorName ?? null, leadId: a.leadId, shootId: a.shootId }));
  return [...notes, ...events].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** Everything the contact page needs in one call. */
export function getContact(ctx: ServiceContext, id: string) {
  const row = getContactRow(ctx, id);
  const leads = ctx.db
    .select({ id: lead.id, createdAt: lead.createdAt, stage: leadStage.name, stageKind: leadStage.kind, shootType: shootType.name, eventDate: lead.eventDate, convertedShootId: lead.convertedShootId })
    .from(lead)
    .innerJoin(leadStage, eq(leadStage.id, lead.stageId))
    .leftJoin(shootType, eq(shootType.id, lead.shootTypeId))
    .where(eq(lead.contactId, id))
    .orderBy(desc(lead.createdAt))
    .all();
  const shoots = ctx.db
    .select({ id: shoot.id, subject: shoot.subject, status: shoot.status, shootType: shootType.name, startsAt: sql<number | null>`(select min(starts_at) from shoot_event where shoot_id = ${shoot.id})` })
    .from(shoot)
    .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
    .where(or(eq(shoot.primaryContactId, id), sql`${shoot.id} in (select shoot_id from shoot_contact where contact_id = ${id})`))
    .orderBy(desc(shoot.createdAt))
    .all();
  const hh = row.householdId ? ctx.db.select().from(household).where(eq(household.id, row.householdId)).get() : null;
  const others = hh ? ctx.db.select().from(contact).where(and(eq(contact.householdId, hh.id), isNull(contact.archivedAt), sql`${contact.id} != ${id}`)).orderBy(asc(contact.firstName), asc(contact.lastName)).all() : [];
  return { ...row, name: displayName(row), tags: tagsFor(ctx, [id]).get(id) ?? [], household: hh ? { id: hh.id, name: hh.name, members: others.map((m) => ({ id: m.id, name: displayName(m), email: m.email, phone: m.phone })) } : null, leads, shoots, timeline: timeline(ctx, id) };
}

/** Looks for a live contact with this email, so a new inquiry reuses the person instead of duplicating them. */
export function findByEmail(ctx: ServiceContext, email: string) {
  return ctx.db.select().from(contact).where(and(eq(contact.email, email.trim().toLowerCase()), isNull(contact.archivedAt))).orderBy(asc(contact.createdAt)).get() ?? null;
}
