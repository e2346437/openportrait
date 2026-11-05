import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNull, or, sql, count } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { createContact, displayName, findByEmail, logActivity } from "./contacts.js";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { NOTE_MAX, cleanRich, safeRich } from "./richtext.js";
import { autoSendForShoot } from "./questionnaires.js";
import { applyTypeTasks } from "./tasks.js";
import {
  cleanSubdir,
  createShootFolder,
  dateParts,
  DEFAULT_DELIVERY_SUBDIR,
  DEFAULT_FOLDER_PATTERN,
  DEFAULT_RAW_SUBDIR,
  renderFolder,
  resolveInside,
  safeSegment,
  uniqueFolder,
  unknownTokens,
  type FolderValues,
} from "./folders.js";

const { shoot, shootEvent, shootContact, shootType, contact } = tables;

export const SHOOT_STATUSES = ["booked", "shot", "editing", "delivered", "complete", "cancelled"] as const;
export type ShootStatus = (typeof SHOOT_STATUSES)[number];

export interface EventInput {
  title?: string;
  startsAt: number;
  endsAt: number;
  allDay?: boolean;
  location?: string | null;
}

// ---- folder settings ----

export function folderSettings(ctx: ServiceContext) {
  return {
    pattern: ctx.settings.get("folders.pattern") ?? DEFAULT_FOLDER_PATTERN,
    rawSubdir: ctx.settings.get("folders.rawSubdir") ?? DEFAULT_RAW_SUBDIR,
    deliverySubdir: ctx.settings.get("folders.deliverySubdir") ?? DEFAULT_DELIVERY_SUBDIR,
  };
}

export function saveFolderSettings(ctx: ServiceContext, input: { pattern: string; rawSubdir: string; deliverySubdir: string }) {
  const pattern = input.pattern.trim();
  const bad = unknownTokens(pattern);
  if (bad.length) throw new DomainError("invalid", `Unknown ${bad.length === 1 ? "token" : "tokens"}: ${bad.map((t) => `{${t}}`).join(", ")}. Use {year} {month} {date} {type} {subject} {client} {location}.`);
  if (!/\{(subject|client)\}/.test(pattern)) throw new DomainError("invalid", "Include {subject} or {client} so two shoots on one day get different folders.");
  if (!/\{(date|year)\}/.test(pattern)) throw new DomainError("invalid", "Include {date} or {year} so folders sort by when they were shot.");
  const rawSubdir = cleanSubdir(input.rawSubdir);
  const deliverySubdir = cleanSubdir(input.deliverySubdir);
  if (!deliverySubdir) throw new DomainError("invalid", "Name the folder your exports go in, for example Gallery.");
  if (rawSubdir === deliverySubdir || rawSubdir.startsWith(`${deliverySubdir}/`) || deliverySubdir.startsWith(`${rawSubdir}/`)) {
    throw new DomainError("invalid", "The camera-file folder and the delivery folder have to be separate, not one inside the other.");
  }
  ctx.settings.set("folders.pattern", pattern);
  ctx.settings.set("folders.rawSubdir", rawSubdir);
  ctx.settings.set("folders.deliverySubdir", deliverySubdir);
  return folderSettings(ctx);
}

export function previewFolder(ctx: ServiceContext, pattern: string): string {
  const sample: FolderValues = { year: "2026", month: "11", date: "2026-11-14", type: "Headshot", subject: "Jane Smith", client: "Jane Smith", location: "Riverside Park" };
  return renderFolder(pattern, sample) ?? "";
}

// ---- reads ----

function shootRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(shoot).where(eq(shoot.id, id)).get();
  if (!row) throw notFound("Shoot");
  return row;
}

const firstStart = sql<number | null>`(select min(starts_at) from shoot_event where shoot_event.shoot_id = ${shoot.id})`;

export interface ShootQuery {
  q?: string;
  status?: ShootStatus | "active";
  when?: "upcoming" | "past" | "all";
  limit?: number;
  offset?: number;
  /** Only these shoots. An empty list matches nothing. */
  ids?: string[];
  /** Child shoots of a group day are hidden from lists by default; `show` mixes them in, `only` lists just the children of `parentId`. */
  children?: "hide" | "show" | "only";
  parentId?: string;
}

export function listShoots(ctx: ServiceContext, query: ShootQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const conditions = [];
  if (query.parentId) conditions.push(eq(shoot.parentId, query.parentId));
  else if ((query.children ?? "hide") === "hide") conditions.push(isNull(shoot.parentId));
  else if (query.children === "only") conditions.push(sql`${shoot.parentId} is not null`);
  if (query.ids) conditions.push(query.ids.length ? inArray(shoot.id, query.ids) : sql`0`);
  if (query.status === "active") conditions.push(sql`${shoot.status} not in ('complete', 'cancelled')`);
  else if (query.status) conditions.push(eq(shoot.status, query.status));
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (query.when === "upcoming") conditions.push(sql`${firstStart} >= ${startOfToday.getTime()}`);
  if (query.when === "past") conditions.push(sql`(${firstStart} is null or ${firstStart} < ${startOfToday.getTime()})`);
  const q = query.q?.trim();
  if (q) {
    for (const word of q.split(/\s+/).slice(0, 6)) {
      const pattern = `%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conditions.push(
        or(
          sql`${shoot.subject} like ${pattern} escape '\\'`,
          sql`${contact.firstName} like ${pattern} escape '\\'`,
          sql`${contact.lastName} like ${pattern} escape '\\'`,
          sql`${shootType.name} like ${pattern} escape '\\'`,
        )!,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const base = ctx.db.select({ n: count() }).from(shoot).innerJoin(contact, eq(contact.id, shoot.primaryContactId)).innerJoin(shootType, eq(shootType.id, shoot.shootTypeId)).where(where);
  const total = base.get()?.n ?? 0;
  const upcomingFirst = query.when === "upcoming";
  const rows = ctx.db
    .select({
      id: shoot.id,
      subject: shoot.subject,
      status: shoot.status,
      folderPath: shoot.folderPath,
      parentId: shoot.parentId,
      kind: shoot.kind,
      shootType: shootType.name,
      shootTypeId: shootType.id,
      contactId: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      company: contact.company,
      email: contact.email,
      startsAt: firstStart,
      location: sql<string | null>`(select location from shoot_event where shoot_event.shoot_id = ${shoot.id} order by starts_at limit 1)`,
    })
    .from(shoot)
    .innerJoin(contact, eq(contact.id, shoot.primaryContactId))
    .innerJoin(shootType, eq(shootType.id, shoot.shootTypeId))
    .where(where)
    .orderBy(upcomingFirst ? asc(sql`coalesce(${firstStart}, 9e15)`) : desc(sql`coalesce(${firstStart}, ${shoot.createdAt})`))
    .limit(limit)
    .offset(offset)
    .all();
  return { total, items: rows.map(({ firstName, lastName, company, email, ...r }) => ({ ...r, client: displayName({ firstName, lastName, company, email }) })) };
}

export function getShoot(ctx: ServiceContext, id: string) {
  const row = shootRow(ctx, id);
  const type = ctx.db.select().from(shootType).where(eq(shootType.id, row.shootTypeId)).get()!;
  const primary = ctx.db.select().from(contact).where(eq(contact.id, row.primaryContactId)).get()!;
  const events = ctx.db.select().from(shootEvent).where(eq(shootEvent.shootId, id)).orderBy(asc(shootEvent.startsAt)).all();
  const others = ctx.db
    .select({ contactId: contact.id, role: shootContact.role, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email })
    .from(shootContact)
    .innerJoin(contact, eq(contact.id, shootContact.contactId))
    .where(eq(shootContact.shootId, id))
    .all()
    .map(({ firstName, lastName, company, email, ...r }) => ({ ...r, name: displayName({ firstName, lastName, company, email }), email }));
  const fs_ = folderSettings(ctx);
  let folderExists = false;
  if (row.folderPath) {
    try {
      folderExists = fs.existsSync(resolveInside(ctx.config.galleriesDir, row.folderPath));
    } catch {
      folderExists = false;
    }
  }
  return {
    ...row,
    notes: row.notes ? safeRich(row.notes) : row.notes,
    shootType: type,
    primary: { id: primary.id, name: displayName(primary), email: primary.email, phone: primary.phone },
    events,
    contacts: others,
    children: row.kind === "group_day" ? listChildren(ctx, id) : [],
    parent: row.parentId ? (ctx.db.select({ id: shoot.id, subject: shoot.subject }).from(shoot).where(eq(shoot.id, row.parentId)).get() ?? null) : null,
    folder: row.folderPath ? { path: row.folderPath, exists: folderExists, rawSubdir: fs_.rawSubdir, deliverySubdir: fs_.deliverySubdir } : null,
  };
}

// ---- writes ----

export function createShoot(
  ctx: ServiceContext,
  input: { primaryContactId: string; shootTypeId: string; subject?: string; leadId?: string | null; events?: EventInput[]; notes?: string | null; kind?: "single" | "group_day" },
) {
  const primary = ctx.db.select().from(contact).where(eq(contact.id, input.primaryContactId)).get();
  if (!primary) throw notFound("Contact");
  const type = ctx.db.select().from(shootType).where(and(eq(shootType.id, input.shootTypeId), isNull(shootType.archivedAt))).get();
  if (!type) throw new DomainError("invalid", "Choose a shoot type.");
  for (const e of input.events ?? []) checkEvent(e);
  const id = newId();
  const subject = input.subject?.trim() || displayName(primary);
  ctx.db.transaction((tx) => {
    tx.insert(shoot).values({ id, subject, kind: input.kind ?? "single", shootTypeId: type.id, primaryContactId: primary.id, leadId: input.leadId ?? null, notes: cleanNotes(input.notes) }).run();
    for (const e of input.events ?? []) tx.insert(shootEvent).values(eventValues(id, e)).run();
  });
  logActivity(ctx, { contactId: primary.id, shootId: id, leadId: input.leadId ?? null, kind: "shoot.created", summary: `${type.name} shoot booked for ${subject}` });
  const folderError = ensureFolder(ctx, id);
  applyTypeTasks(ctx, id);
  autoSendForShoot(ctx, id);
  return { shoot: getShoot(ctx, id), folderError };
}

function checkEvent(e: EventInput) {
  if (!Number.isFinite(e.startsAt) || !Number.isFinite(e.endsAt)) throw new DomainError("invalid", "Enter a start and end time.");
  if (e.endsAt < e.startsAt) throw new DomainError("invalid", "The end can't be before the start.");
}

function eventValues(shootId: string, e: EventInput): typeof shootEvent.$inferInsert {
  return { id: newId(), shootId, title: e.title?.trim() ?? "", startsAt: new Date(e.startsAt), endsAt: new Date(e.endsAt), allDay: e.allDay ?? false, location: e.location?.trim() || null };
}

function cleanNotes(notes: string | null | undefined): string | null {
  const t = cleanRich(notes);
  if (t.length > NOTE_MAX) throw new DomainError("invalid", "Those notes are too long.");
  return t || null;
}

export function updateShoot(ctx: ServiceContext, id: string, input: { subject?: string; shootTypeId?: string; status?: ShootStatus; notes?: string | null; primaryContactId?: string; billTo?: "self" | "parent"; showOnMaster?: boolean; headcount?: number }) {
  const current = shootRow(ctx, id);
  const patch: Partial<typeof shoot.$inferInsert> = {};
  if (input.subject !== undefined) {
    if (!input.subject.trim()) throw new DomainError("invalid", "Who is being photographed? Add a subject.");
    patch.subject = input.subject.trim();
  }
  if (input.shootTypeId !== undefined) {
    if (!ctx.db.select().from(shootType).where(eq(shootType.id, input.shootTypeId)).get()) throw new DomainError("invalid", "Choose a shoot type.");
    patch.shootTypeId = input.shootTypeId;
  }
  if (input.status !== undefined) patch.status = input.status;
  if (input.billTo !== undefined) {
    if (input.billTo === "parent" && !current.parentId && current.kind !== "group_day") throw new DomainError("invalid", "Only a group day or a person on one can use the day's invoice.");
    patch.billTo = input.billTo;
  }
  if (input.showOnMaster !== undefined) patch.showOnMaster = input.showOnMaster;
  if (input.headcount !== undefined) {
    if (!Number.isInteger(input.headcount) || input.headcount < 1 || input.headcount > 99) throw new DomainError("invalid", "Enter how many people this covers, from 1 to 99.");
    patch.headcount = input.headcount;
  }
  if (input.notes !== undefined) patch.notes = cleanNotes(input.notes);
  if (input.primaryContactId !== undefined) {
    if (!ctx.db.select().from(contact).where(eq(contact.id, input.primaryContactId)).get()) throw notFound("Contact");
    patch.primaryContactId = input.primaryContactId;
  }
  // The folder is deliberately left alone: renaming a shoot must not break export presets pointing at it.
  ctx.db.update(shoot).set({ ...patch, updatedAt: new Date() }).where(eq(shoot.id, id)).run();
  if (input.status && input.status !== current.status) {
    logActivity(ctx, { contactId: patch.primaryContactId ?? current.primaryContactId, shootId: id, kind: "shoot.status", summary: `${patch.subject ?? current.subject}: marked ${input.status}` });
  }
  return getShoot(ctx, id);
}

export function addEvent(ctx: ServiceContext, shootId: string, input: EventInput) {
  shootRow(ctx, shootId);
  checkEvent(input);
  ctx.db.insert(shootEvent).values(eventValues(shootId, input)).run();
  const folderError = ensureFolder(ctx, shootId);
  return { shoot: getShoot(ctx, shootId), folderError };
}

export function updateEvent(ctx: ServiceContext, shootId: string, eventId: string, input: Partial<EventInput>) {
  const existing = ctx.db.select().from(shootEvent).where(and(eq(shootEvent.id, eventId), eq(shootEvent.shootId, shootId))).get();
  if (!existing) throw notFound("Event");
  const merged = { startsAt: input.startsAt ?? existing.startsAt.getTime(), endsAt: input.endsAt ?? existing.endsAt.getTime() };
  checkEvent(merged);
  ctx.db
    .update(shootEvent)
    .set({
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      startsAt: new Date(merged.startsAt),
      endsAt: new Date(merged.endsAt),
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      ...(input.location !== undefined ? { location: input.location?.trim() || null } : {}),
    })
    .where(eq(shootEvent.id, eventId))
    .run();
  return getShoot(ctx, shootId);
}

export function removeEvent(ctx: ServiceContext, shootId: string, eventId: string) {
  const res = ctx.db.delete(shootEvent).where(and(eq(shootEvent.id, eventId), eq(shootEvent.shootId, shootId))).run();
  if (!res.changes) throw notFound("Event");
  return getShoot(ctx, shootId);
}

export function addShootContact(ctx: ServiceContext, shootId: string, contactId: string, role = "") {
  const row = shootRow(ctx, shootId);
  if (!ctx.db.select().from(contact).where(eq(contact.id, contactId)).get()) throw notFound("Contact");
  if (contactId === row.primaryContactId) throw new DomainError("invalid", "They are already the main contact.");
  ctx.db.insert(shootContact).values({ shootId, contactId, role: role.trim() }).onConflictDoUpdate({ target: [shootContact.shootId, shootContact.contactId], set: { role: role.trim() } }).run();
  return getShoot(ctx, shootId);
}

export function removeShootContact(ctx: ServiceContext, shootId: string, contactId: string) {
  ctx.db.delete(shootContact).where(and(eq(shootContact.shootId, shootId), eq(shootContact.contactId, contactId))).run();
  return getShoot(ctx, shootId);
}

// ---- folders ----

function folderTaken(ctx: ServiceContext, rel: string, ignoreShootId?: string): boolean {
  const lower = rel.toLowerCase();
  const inDb = ctx.db
    .select({ id: shoot.id })
    .from(shoot)
    .where(sql`lower(${shoot.folderPath}) = ${lower}`)
    .all()
    .some((r) => r.id !== ignoreShootId);
  if (inDb) return true;
  try {
    return fs.existsSync(resolveInside(ctx.config.galleriesDir, rel));
  } catch {
    return true;
  }
}

function folderValues(ctx: ServiceContext, id: string): FolderValues | null {
  const row = shootRow(ctx, id);
  const start = ctx.db.select({ s: sql<number | null>`min(${shootEvent.startsAt})` }).from(shootEvent).where(eq(shootEvent.shootId, id)).get()?.s;
  if (!start) return null; // no date yet, so there is nothing to name the folder after
  const type = ctx.db.select().from(shootType).where(eq(shootType.id, row.shootTypeId)).get()!;
  const primary = ctx.db.select().from(contact).where(eq(contact.id, row.primaryContactId)).get()!;
  const place = ctx.db.select({ l: shootEvent.location }).from(shootEvent).where(eq(shootEvent.shootId, id)).orderBy(asc(shootEvent.startsAt)).get()?.l ?? "";
  const when = dateParts(new Date(start), ctx.settings.get("studio.timezone") ?? "UTC");
  return { year: when.year, month: when.month, date: when.date, type: type.folderLabel, subject: row.subject, client: displayName(primary), location: place ?? "" };
}

/** A group day keeps only the camera-file folder (for frames not yet sorted): its delivery folders belong to the people on it. */
function subdirsToCreate(ctx: ServiceContext, kind: "single" | "group_day" = "single"): string[] {
  const s = folderSettings(ctx);
  return (kind === "group_day" ? [s.rawSubdir] : [s.rawSubdir, s.deliverySubdir]).filter(Boolean);
}

/**
 * Creates the shoot's folder (and its Originals/RAW and delivery subfolders) once it has a date.
 * Returns a plain-language problem if the share can't be written to; the shoot is saved either way.
 */
export function ensureFolder(ctx: ServiceContext, id: string): string | null {
  const row = shootRow(ctx, id);
  if (row.folderPath) return null;
  const values = folderValues(ctx, id);
  if (!values) return null;
  const rel = renderFolder(folderSettings(ctx).pattern, values);
  if (!rel) return "The folder pattern produced an empty name. Check Settings > Galleries.";
  const unique = uniqueFolder(rel, (c) => folderTaken(ctx, c, id));
  try {
    createShootFolder(ctx.config.galleriesDir, unique, subdirsToCreate(ctx, row.kind));
  } catch (err) {
    logActivity(ctx, { contactId: row.primaryContactId, shootId: id, kind: "shoot.folder_failed", summary: `Folder not created: ${(err as Error).message}` });
    return (err as Error).message;
  }
  ctx.db.update(shoot).set({ folderPath: unique }).where(eq(shoot.id, id)).run();
  return null;
}

/** Renames the folder to match the current pattern (the "Rename folder" button). Never done automatically. */
export function renameFolder(ctx: ServiceContext, id: string) {
  const row = shootRow(ctx, id);
  if (!row.folderPath) {
    const problem = ensureFolder(ctx, id);
    if (problem) throw new DomainError("folder", problem);
    return getShoot(ctx, id);
  }
  const values = folderValues(ctx, id);
  if (!values) throw new DomainError("invalid", "Add a date to the shoot first.");
  const wanted = renderFolder(folderSettings(ctx).pattern, values);
  if (!wanted) throw new DomainError("invalid", "The folder pattern produced an empty name.");
  if (wanted.toLowerCase() === row.folderPath.toLowerCase() && wanted === row.folderPath) return getShoot(ctx, id);
  const target = uniqueFolder(wanted, (c) => c !== row.folderPath && folderTaken(ctx, c, id));
  if (target === row.folderPath) return getShoot(ctx, id);
  try {
    const from = resolveInside(ctx.config.galleriesDir, row.folderPath);
    const to = resolveInside(ctx.config.galleriesDir, target);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    createShootFolder(ctx.config.galleriesDir, target, subdirsToCreate(ctx));
  } catch (err) {
    throw new DomainError("folder", `The folder couldn't be renamed: ${(err as Error).message}`);
  }
  ctx.db.update(shoot).set({ folderPath: target, updatedAt: new Date() }).where(eq(shoot.id, id)).run();
  logActivity(ctx, { contactId: row.primaryContactId, shootId: id, kind: "shoot.folder_renamed", summary: `Folder renamed to ${target}` });
  return getShoot(ctx, id);
}

// ---- group days: a parent shoot with one child shoot per person or family ----

export interface Child {
  id: string;
  subject: string;
  status: ShootStatus;
  folderPath: string | null;
  contactId: string;
  email: string | null;
  billTo: "self" | "parent";
  showOnMaster: boolean;
}

export function listChildren(ctx: ServiceContext, parentId: string): Child[] {
  return ctx.db
    .select({ id: shoot.id, subject: shoot.subject, status: shoot.status, folderPath: shoot.folderPath, contactId: contact.id, email: contact.email, billTo: shoot.billTo, showOnMaster: shoot.showOnMaster })
    .from(shoot)
    .innerJoin(contact, eq(contact.id, shoot.primaryContactId))
    .where(eq(shoot.parentId, parentId))
    .orderBy(asc(shoot.createdAt), asc(shoot.subject))
    .all();
}

/** Turns an ordinary shoot into a group day. Only possible while it is not itself someone's child. */
export function makeGroupDay(ctx: ServiceContext, id: string, billTo: "self" | "parent" = "self") {
  const row = shootRow(ctx, id);
  if (row.parentId) throw new DomainError("invalid", "This shoot is a person on a group day, so it can't be a group day itself.");
  // On a day itself, `billTo` is the default for people added later: `parent` means the day's invoice covers them.
  // A day's folder must not look like a gallery to the folder scanner, or the people's galleries inside it are never found.
  if (row.folderPath) {
    const delivery = resolveInside(ctx.config.galleriesDir, `${row.folderPath}/${folderSettings(ctx).deliverySubdir}`);
    try {
      if (fs.existsSync(delivery)) {
        if (fs.readdirSync(delivery).length) throw new DomainError("invalid", "This shoot's delivery folder already has files in it, so it can't become a group day.");
        fs.rmdirSync(delivery);
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
    }
  }
  ctx.db.update(shoot).set({ kind: "group_day", billTo, updatedAt: new Date() }).where(eq(shoot.id, id)).run();
  return getShoot(ctx, id);
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1]! };
}

/**
 * Adds a person or family to a group day. An email that matches an existing contact reuses that contact;
 * otherwise a new one is made. The child gets its own folder inside the day's folder.
 */
export function addChild(ctx: ServiceContext, parentId: string, input: { name: string; email?: string | null; contactId?: string; billTo?: "self" | "parent" }) {
  const parent = shootRow(ctx, parentId);
  if (parent.kind !== "group_day") throw new DomainError("invalid", "Make this shoot a group day first.");
  const name = input.name.trim();
  if (!name) throw new DomainError("invalid", "Who is this? Add a name.");
  if (name.length > 120) throw new DomainError("invalid", "That name is too long.");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("invalid", `"${input.email}" doesn't look like an email address.`);
  let matched = false;
  let person = input.contactId ? ctx.db.select().from(contact).where(eq(contact.id, input.contactId)).get() : undefined;
  if (input.contactId && !person) throw notFound("Contact");
  if (!person && email) {
    person = findByEmail(ctx, email) ?? undefined;
    matched = !!person;
  }
  if (!person) person = createContact(ctx, { ...splitName(name), email, source: "group day" });
  const existing = listChildren(ctx, parentId).find((c) => c.contactId === person!.id);
  if (existing) return { child: existing, matched: true, duplicate: true, folderError: null as string | null };

  const billTo = input.billTo ?? parent.billTo;
  const id = newId();
  ctx.db.insert(shoot).values({ id, subject: name, kind: "single", parentId, billTo, shootTypeId: parent.shootTypeId, primaryContactId: person.id }).run();
  logActivity(ctx, { contactId: person.id, shootId: id, kind: "shoot.created", summary: `Added to ${parent.subject}` });
  const folderError = ensureChildFolder(ctx, id);
  return { child: listChildren(ctx, parentId).find((c) => c.id === id)!, matched, duplicate: false, folderError };
}

/** The child's folder sits inside the day's folder, with its own Originals/RAW and delivery subfolders. */
export function ensureChildFolder(ctx: ServiceContext, id: string): string | null {
  const row = shootRow(ctx, id);
  if (row.folderPath) return null;
  const parent = row.parentId ? shootRow(ctx, row.parentId) : null;
  if (!parent?.folderPath) return "Add a date to the day first, so its folder exists.";
  const seg = safeSegment(row.subject) || "Person";
  const unique = uniqueFolder(`${parent.folderPath}/${seg}`, (c) => folderTaken(ctx, c, id));
  try {
    createShootFolder(ctx.config.galleriesDir, unique, subdirsToCreate(ctx));
  } catch (err) {
    return (err as Error).message;
  }
  ctx.db.update(shoot).set({ folderPath: unique }).where(eq(shoot.id, id)).run();
  return null;
}

/** Reads a pasted list, one person per line: `Name, email` (email optional; tabs and semicolons work too). */
export function parseRoster(text: string): { people: Array<{ name: string; email: string | null }>; skipped: string[] } {
  const people: Array<{ name: string; email: string | null }> = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!line.includes("@") && /^name\b/i.test(cells[0] ?? "")) continue; // header row
    const emailCell = cells.find((c) => c.includes("@"));
    const name = cells.filter((c) => c && c !== emailCell).join(" ").trim();
    if (!name) {
      skipped.push(line);
      continue;
    }
    const key = `${name.toLowerCase()}|${emailCell?.toLowerCase() ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name, email: emailCell ?? null });
  }
  return { people, skipped };
}

export function importRoster(ctx: ServiceContext, parentId: string, text: string) {
  if (text.length > 200_000) throw new DomainError("invalid", "That list is too long. Import it in parts.");
  const { people, skipped } = parseRoster(text);
  if (people.length > 500) throw new DomainError("invalid", "Import at most 500 people at a time.");
  const out = { added: 0, reused: 0, duplicates: 0, skipped: [...skipped], problems: [] as string[] };
  for (const p of people) {
    try {
      const r = addChild(ctx, parentId, p);
      if (r.duplicate) out.duplicates++;
      else {
        out.added++;
        if (r.matched) out.reused++;
        if (r.folderError) out.problems.push(`${p.name}: ${r.folderError}`);
      }
    } catch (err) {
      if (err instanceof DomainError) out.skipped.push(`${p.name}${p.email ? `, ${p.email}` : ""}: ${err.message}`);
      else throw err;
    }
  }
  return { ...out, children: listChildren(ctx, parentId) };
}
