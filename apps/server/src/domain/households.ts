import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { displayName, logActivity } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";

const { household, contact } = tables;

const cleanName = (n: string | undefined): string => {
  const t = (n ?? "").trim().slice(0, 120);
  if (!t) throw new DomainError("invalid", "Give the household a name.");
  return t;
};

function contactRow(ctx: ServiceContext, id: string) {
  const c = ctx.db.select().from(contact).where(eq(contact.id, id)).get();
  if (!c) throw notFound("Contact");
  return c;
}

/** A household and the people in it. */
export function getHousehold(ctx: ServiceContext, id: string) {
  const h = ctx.db.select().from(household).where(eq(household.id, id)).get();
  if (!h) throw notFound("Household");
  const members = ctx.db.select().from(contact).where(and(eq(contact.householdId, id), isNull(contact.archivedAt))).orderBy(asc(contact.firstName), asc(contact.lastName)).all();
  return { id: h.id, name: h.name, members: members.map((m) => ({ id: m.id, name: displayName(m), email: m.email, phone: m.phone })) };
}

export function renameHousehold(ctx: ServiceContext, id: string, name: string) {
  getHousehold(ctx, id);
  ctx.db.update(household).set({ name: cleanName(name) }).where(eq(household.id, id)).run();
  return getHousehold(ctx, id);
}

/** Households nobody is in any more are removed, so the list never fills with empty ones. */
function dropIfEmpty(ctx: ServiceContext, householdId: string | null) {
  if (!householdId) return;
  const n = ctx.db.select({ n: sql<number>`count(*)` }).from(contact).where(eq(contact.householdId, householdId)).get()?.n ?? 0;
  if (n === 0) ctx.db.delete(household).where(eq(household.id, householdId)).run();
}

/**
 * Puts a contact in the same household as another contact, making one (named after them) if that contact has none yet.
 * A contact is in at most one household, so joining a different one moves them.
 */
export function joinHouseholdOf(ctx: ServiceContext, contactId: string, otherId: string) {
  if (contactId === otherId) throw new DomainError("invalid", "Choose someone else.");
  const me = contactRow(ctx, contactId);
  const other = contactRow(ctx, otherId);
  let id = other.householdId;
  if (!id) {
    id = newId();
    const surname = other.lastName.trim() || me.lastName.trim();
    ctx.db.insert(household).values({ id, name: surname ? `${surname} household` : `${displayName(other)} household` }).run();
    ctx.db.update(contact).set({ householdId: id, updatedAt: new Date() }).where(eq(contact.id, otherId)).run();
  }
  const before = me.householdId;
  ctx.db.update(contact).set({ householdId: id, updatedAt: new Date() }).where(eq(contact.id, contactId)).run();
  if (before && before !== id) dropIfEmpty(ctx, before);
  const h = getHousehold(ctx, id);
  logActivity(ctx, { contactId, kind: "contact.household", summary: `Added to ${h.name}` });
  return h;
}

/** Takes a contact out of their household. */
export function leaveHousehold(ctx: ServiceContext, contactId: string) {
  const me = contactRow(ctx, contactId);
  if (!me.householdId) return { ok: true };
  ctx.db.update(contact).set({ householdId: null, updatedAt: new Date() }).where(eq(contact.id, contactId)).run();
  dropIfEmpty(ctx, me.householdId);
  return { ok: true };
}
