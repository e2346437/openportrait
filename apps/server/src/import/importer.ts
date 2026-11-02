import crypto from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { addNote, createContact, displayName, logActivity, setContactTags, updateContact, type ContactInput } from "../domain/contacts.js";
import { DomainError, newId, type ServiceContext } from "../domain/context.js";
import { nextNumber } from "../domain/orders.js";
import { addDays, startOfDay, ymdIn } from "../domain/time.js";
import type { Table } from "./csv.js";
import { FIELDS, mapMethod, mapShootStatus, parseMoneyCents, parseYmd, type ImportKind } from "./fields.js";

const { contact, contactTag, tag, shoot, shootEvent, shootType, order, orderLine, paymentSchedule, payment, importRecord } = tables;

export interface ImportOptions {
  /** Which system the file came from. Part of every remembered key. */
  source: string;
  mapping: Record<string, string>;
  /** Fill in blank fields of contacts that already exist instead of skipping them. */
  updateExisting?: boolean;
}

export interface RowResult {
  /** The row's line in the file, counting the header as line 1. */
  line: number;
  action: "create" | "update" | "skip" | "error";
  label: string;
  notes: string[];
}

export interface ImportReport {
  kind: ImportKind;
  applied: boolean;
  totalRows: number;
  counts: { create: number; update: number; skip: number; error: number };
  created: { contacts: number; shoots: number; shootTypes: number; invoices: number; payments: number };
  rows: RowResult[];
  /** True when `rows` was cut short to keep the response small. */
  truncated: boolean;
}

const ROW_LIMIT = 500;
class Rollback extends Error {}
class Skip extends Error {}
const fail = (m: string) => new DomainError("invalid", m);

type Ctx = ServiceContext;

/**
 * Runs the whole import inside one database transaction. A preview runs exactly the same code and then
 * rolls back, so what it shows is what the real import will do.
 */
export function runImport(ctx: ServiceContext, kind: ImportKind, table: Table, opts: ImportOptions, apply: boolean): ImportReport {
  const missing = FIELDS[kind].filter((f) => f.required && !opts.mapping[f.key]);
  if (missing.length) throw fail(`Choose which column holds the ${missing.map((m) => m.label.toLowerCase()).join(" and ")}.`);
  for (const col of Object.values(opts.mapping)) if (col && !table.headers.includes(col)) throw fail(`The file has no column called “${col}”.`);

  const report: ImportReport = { kind, applied: apply, totalRows: table.rows.length, counts: { create: 0, update: 0, skip: 0, error: 0 }, created: { contacts: 0, shoots: 0, shootTypes: 0, invoices: 0, payments: 0 }, rows: [], truncated: false };
  const push = (r: RowResult) => {
    report.counts[r.action]++;
    if (report.rows.length < ROW_LIMIT) report.rows.push(r);
    else report.truncated = true;
  };
  const batchId = newId();

  try {
    ctx.db.transaction((tx) => {
      const base: Ctx = { ...ctx, db: tx as unknown as Ctx["db"] };
      const run = new Run(base, kind, opts, batchId, report);
      if (kind === "invoices") run.invoices(table, push);
      else
        table.rows.forEach((raw, i) => {
          const line = i + 2;
          try {
            push({ line, ...base.db.transaction((row) => run.withDb(row as unknown as Ctx["db"], () => (kind === "contacts" ? run.contactRow(raw) : run.shootRow(raw)))) });
          } catch (err) {
            run.reset();
            push(errorRow(line, raw, err));
          }
        });
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return report;
}

function errorRow(line: number, raw: Record<string, string>, err: unknown): RowResult {
  if (err instanceof Skip) return { line, action: "skip", label: err.message, notes: [] };
  const msg = err instanceof DomainError ? err.message : "Something unexpected went wrong with this row.";
  if (!(err instanceof DomainError)) console.error("import row failed", err);
  return { line, action: "error", label: Object.values(raw).find(Boolean) ?? `Row ${line}`, notes: [msg] };
}

type Outcome = Omit<RowResult, "line">;

class Run {
  private contactCache = new Map<string, string>();
  private typeCache = new Map<string, string>();
  constructor(
    private ctx: Ctx,
    private kind: ImportKind,
    private opts: ImportOptions,
    private batchId: string,
    private report: ImportReport,
  ) {}

  withDb<T>(db: Ctx["db"], fn: () => T): T {
    const saved = this.ctx;
    this.ctx = { ...saved, db };
    try {
      return fn();
    } finally {
      this.ctx = saved;
    }
  }
  reset() {
    this.contactCache.clear();
    this.typeCache.clear();
  }

  private get(raw: Record<string, string>, key: string): string {
    const col = this.opts.mapping[key];
    return col ? (raw[col] ?? "").trim() : "";
  }
  private get tz() {
    return this.ctx.settings.get("studio.timezone") ?? "UTC";
  }

  // ---- remembered rows ----
  private recall(kind: string, key: string) {
    return this.ctx.db.select().from(importRecord).where(and(eq(importRecord.source, this.opts.source), eq(importRecord.kind, kind), eq(importRecord.externalKey, key.toLowerCase()))).get();
  }
  private remember(kind: string, key: string, entityId: string) {
    this.ctx.db.insert(importRecord).values({ id: newId(), source: this.opts.source, kind, externalKey: key.toLowerCase(), entityId, batchId: this.batchId }).run();
  }

  // ---- contacts ----
  private findContact(p: { email?: string; firstName?: string; lastName?: string; company?: string }): string | null {
    const email = p.email?.toLowerCase();
    const nameKey = `${(p.firstName ?? "").toLowerCase()}|${(p.lastName ?? "").toLowerCase()}`;
    if (email && this.contactCache.has(`e:${email}`)) return this.contactCache.get(`e:${email}`)!;
    if (!email && nameKey !== "|" && this.contactCache.has(`n:${nameKey}`)) return this.contactCache.get(`n:${nameKey}`)!;
    let found: string | undefined;
    if (email) found = this.ctx.db.select({ id: contact.id }).from(contact).where(and(sql`${contact.email} = ${email} collate nocase`, isNull(contact.archivedAt))).orderBy(asc(contact.createdAt)).get()?.id;
    else if (p.firstName || p.lastName)
      found = this.ctx.db
        .select({ id: contact.id })
        .from(contact)
        .where(and(sql`lower(${contact.firstName}) = ${(p.firstName ?? "").toLowerCase()}`, sql`lower(${contact.lastName}) = ${(p.lastName ?? "").toLowerCase()}`, isNull(contact.archivedAt)))
        .get()?.id;
    if (found) this.contactCache.set(email ? `e:${email}` : `n:${nameKey}`, found);
    return found ?? null;
  }

  private contactInput(raw: Record<string, string>): ContactInput {
    const g = (k: string) => this.get(raw, k) || undefined;
    const email = g("email");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(`“${email}” isn't a valid email address. Fix it in the file and import again.`);
    return { firstName: g("firstName"), lastName: g("lastName"), company: g("company"), email: g("email"), phone: g("phone"), addressLine1: g("addressLine1"), addressLine2: g("addressLine2"), city: g("city"), region: g("region"), postalCode: g("postalCode"), country: g("country"), source: g("source") };
  }

  private cacheNew(id: string, i: ContactInput) {
    if (i.email) this.contactCache.set(`e:${i.email.toLowerCase()}`, id);
    else this.contactCache.set(`n:${(i.firstName ?? "").toLowerCase()}|${(i.lastName ?? "").toLowerCase()}`, id);
  }

  /** Finds the client a shoot or invoice row names, or adds them. */
  private client(input: ContactInput): { id: string; created: boolean } {
    const found = this.findContact({ email: input.email ?? undefined, firstName: input.firstName, lastName: input.lastName });
    if (found) return { id: found, created: false };
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw fail(`“${input.email}” isn't a valid email address.`);
    if (!(input.email || input.firstName || input.lastName || input.company)) throw fail("This row doesn't say who the client is. Map a client name or email column.");
    const created = createContact(this.ctx, { ...input, source: input.source ?? this.opts.source });
    this.cacheNew(created.id, input);
    this.report.created.contacts++;
    return { id: created.id, created: true };
  }

  contactRow(raw: Record<string, string>): Outcome {
    const input = this.contactInput(raw);
    const label = displayName({ firstName: input.firstName ?? "", lastName: input.lastName ?? "", company: input.company, email: input.email });
    const key = this.get(raw, "externalId") || input.email || `${input.firstName ?? ""} ${input.lastName ?? ""}|${input.company ?? ""}`;
    if (!(input.firstName || input.lastName || input.company || input.email)) throw fail("This row has no name, company or email.");
    if (this.recall("contact", key)) return { action: "skip", label, notes: ["Imported before."] };
    const tags = this.get(raw, "tags").split(/[,;]/).map((t) => t.trim()).filter(Boolean);
    const noteText = this.get(raw, "notes");
    const existing = this.findContact({ email: input.email ?? undefined, firstName: input.firstName, lastName: input.lastName });
    if (existing) {
      if (!this.opts.updateExisting) {
        this.remember("contact", key, existing);
        return { action: "skip", label, notes: ["Already in OpenPortrait."] };
      }
      const current = this.ctx.db.select().from(contact).where(eq(contact.id, existing)).get()!;
      const fill: ContactInput = {};
      const filled: string[] = [];
      for (const [k, v] of Object.entries(input) as Array<[keyof ContactInput, string | undefined]>) {
        if (v && !current[k as keyof typeof current]) {
          fill[k] = v;
          filled.push(k);
        }
      }
      if (filled.length) updateContact(this.ctx, existing, fill);
      this.addTagsAndNote(existing, tags, noteText);
      this.remember("contact", key, existing);
      return filled.length || tags.length || noteText ? { action: "update", label, notes: filled.length ? [`Filled in: ${filled.join(", ")}.`] : ["Tags or notes added."] } : { action: "skip", label, notes: ["Nothing new to add."] };
    }
    const created = createContact(this.ctx, { ...input, source: input.source ?? this.opts.source });
    this.cacheNew(created.id, input);
    this.addTagsAndNote(created.id, tags, noteText);
    this.remember("contact", key, created.id);
    this.report.created.contacts++;
    return { action: "create", label, notes: [] };
  }

  private addTagsAndNote(contactId: string, tags: string[], noteText: string) {
    if (tags.length) {
      const have = this.ctx.db.select({ name: tag.name }).from(contactTag).innerJoin(tag, eq(tag.id, contactTag.tagId)).where(eq(contactTag.contactId, contactId)).all().map((r) => r.name);
      setContactTags(this.ctx, contactId, [...have, ...tags]);
    }
    if (noteText) addNote(this.ctx, contactId, `Imported from ${this.opts.source}: ${noteText}`);
  }

  // ---- shoots ----
  private shootTypeId(name: string): { id: string; created: boolean } {
    const label = name || "Uncategorized";
    const k = label.toLowerCase();
    const cached = this.typeCache.get(k);
    if (cached) return { id: cached, created: false };
    const found = this.ctx.db.select({ id: shootType.id }).from(shootType).where(and(sql`lower(${shootType.name}) = ${k}`, isNull(shootType.archivedAt))).get();
    if (found) {
      this.typeCache.set(k, found.id);
      return { id: found.id, created: false };
    }
    const last = this.ctx.db.select({ p: sql<number>`coalesce(max(${shootType.position}), -1)` }).from(shootType).get()?.p ?? -1;
    const id = newId();
    this.ctx.db.insert(shootType).values({ id, name: label.slice(0, 80), folderLabel: label.slice(0, 80), position: last + 1 }).run();
    this.typeCache.set(k, id);
    this.report.created.shootTypes++;
    return { id, created: true };
  }

  shootRow(raw: Record<string, string>): Outcome {
    const name = this.get(raw, "name");
    if (!name) throw fail("This row has no shoot name.");
    const dateRaw = this.get(raw, "date");
    const date = dateRaw ? parseYmd(dateRaw) : null;
    const notes: string[] = [];
    if (dateRaw && !date) notes.push(`Couldn't read the date “${dateRaw}”. The shoot is added without a date.`);
    const input: ContactInput = { firstName: this.get(raw, "firstName") || undefined, lastName: this.get(raw, "lastName") || undefined, email: this.get(raw, "email") || undefined };
    const key = this.get(raw, "externalId") || `${name}|${date ?? ""}|${input.email ?? `${input.firstName ?? ""} ${input.lastName ?? ""}`}`;
    if (this.recall("shoot", key)) return { action: "skip", label: name, notes: ["Imported before."] };
    const c = this.client(input);
    if (c.created) notes.push("New client added.");
    const type = this.shootTypeId(this.get(raw, "type"));
    if (type.created) notes.push(`New shoot type: ${this.get(raw, "type") || "Uncategorized"}.`);
    const id = newId();
    const when = date ? new Date(startOfDay(date, this.tz)) : new Date();
    this.ctx.db.insert(shoot).values({ id, subject: name.slice(0, 200), shootTypeId: type.id, status: mapShootStatus(this.get(raw, "status")), primaryContactId: c.id, notes: this.get(raw, "notes") || null, createdAt: when, updatedAt: when }).run();
    if (date) this.ctx.db.insert(shootEvent).values({ id: newId(), shootId: id, title: "", startsAt: new Date(startOfDay(date, this.tz)), endsAt: new Date(startOfDay(addDays(date, 1), this.tz)), allDay: true }).run();
    logActivity(this.ctx, { contactId: c.id, shootId: id, kind: "shoot.imported", summary: `Shoot imported from ${this.opts.source}: ${name}` });
    this.remember("shoot", key, id);
    this.report.created.shoots++;
    return { action: "create", label: name, notes };
  }

  // ---- invoices and their payments ----
  invoices(table: Table, push: (r: RowResult) => void) {
    const groups = new Map<string, Array<{ raw: Record<string, string>; line: number }>>();
    table.rows.forEach((raw, i) => {
      const num = this.get(raw, "orderNumber");
      if (!num) return push({ line: i + 2, action: "error", label: Object.values(raw).find(Boolean) ?? `Row ${i + 2}`, notes: ["This row has no order number."] });
      groups.set(num, [...(groups.get(num) ?? []), { raw, line: i + 2 }]);
    });
    for (const [num, rows] of groups) {
      const line = rows[0]!.line;
      try {
        const out = this.ctx.db.transaction((tx) => this.withDb(tx as unknown as Ctx["db"], () => this.invoice(num, rows.map((r) => r.raw))));
        push({ line, ...out });
      } catch (err) {
        this.reset();
        push(errorRow(line, rows[0]!.raw, err));
      }
    }
  }

  private invoice(num: string, rows: Array<Record<string, string>>): Outcome {
    const first = (k: string) => rows.map((r) => this.get(r, k)).find(Boolean) ?? "";
    const label = `Invoice ${num}`;
    const key = this.get(rows[0]!, "externalId") || num;
    const today = ymdIn(Date.now(), this.tz);
    const noon = (ymd: string) => startOfDay(ymd, this.tz) + 12 * 3_600_000;
    const notes: string[] = [];

    // The payments in the file (blank and zero amounts are not payments).
    const pays: Array<{ cents: number; paidOn: string; method: ReturnType<typeof mapMethod>; ref: string }> = [];
    const seen = new Map<string, number>();
    for (const r of rows) {
      const cents = parseMoneyCents(this.get(r, "amount"));
      if (!cents) continue;
      const rawDate = this.get(r, "paidOn") || this.get(r, "created");
      const paidOn = (rawDate && parseYmd(rawDate)) || today;
      const base = `${key}|${paidOn}|${cents}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      pays.push({ cents, paidOn, method: mapMethod(this.get(r, "method")), ref: `${base}|${n}` });
    }
    const paidTotal = pays.reduce((s, p) => s + p.cents, 0);
    const existing = this.recall("invoice", key);

    if (existing) {
      // Same invoice seen before: only add payments that weren't imported yet.
      const fresh = pays.filter((p) => !this.ctx.db.select({ id: payment.id }).from(payment).where(and(eq(payment.provider, "import"), eq(payment.providerRef, p.ref))).get());
      for (const p of fresh) this.addPayment(existing.entityId, p, noon(p.paidOn));
      this.bumpTotal(existing.entityId);
      return fresh.length ? { action: "update", label, notes: [`${fresh.length} new payment${fresh.length === 1 ? "" : "s"} added.`] } : { action: "skip", label, notes: ["Imported before."] };
    }

    const email = first("email");
    const c = this.client({ firstName: first("firstName") || undefined, lastName: first("lastName") || undefined, company: first("company") || undefined, email: email || undefined });
    if (c.created) notes.push("New client added.");
    const totalRaw = first("total");
    let total = totalRaw ? (parseMoneyCents(totalRaw) ?? paidTotal) : paidTotal;
    if (total < paidTotal) {
      notes.push("Payments add up to more than the invoice total, so the total was raised to match.");
      total = paidTotal;
    }
    const shootName = first("shoot");
    const shootRow = shootName ? this.ctx.db.select({ id: shoot.id }).from(shoot).where(sql`${shoot.subject} = ${shootName} collate nocase`).get() : undefined;
    const title = (first("title") || `Order ${num}`).slice(0, 300);
    const createdRaw = first("created");
    const created = (createdRaw && parseYmd(createdRaw)) || pays.map((p) => p.paidOn).sort()[0] || today;
    const statusText = first("status").toLowerCase();
    const status = /void|cancel/.test(statusText) ? "void" : "sent";
    if (status === "void" && paidTotal !== 0) notes.push("Marked void even though it has payments. Check it.");
    const id = newId();
    const when = new Date(noon(created));
    this.ctx.db
      .insert(order)
      .values({ id, kind: "invoice", status, invoiceNumber: nextNumber(this.ctx.db as never, "invoice"), contactId: c.id, shootId: shootRow?.id ?? null, title, intro: `Imported from ${this.opts.source}, order ${num}.`, subtotalCents: total, totalCents: total, token: crypto.randomBytes(24).toString("base64url"), sentAt: when, createdAt: when, updatedAt: when })
      .run();
    this.ctx.db.insert(orderLine).values({ id: newId(), orderId: id, position: 0, description: title, quantity: 1, unitCents: total, taxable: false }).run();
    this.ctx.db.insert(paymentSchedule).values({ id: newId(), orderId: id, position: 0, label: "Payment in full", amountCents: total }).run();
    for (const p of pays) this.addPayment(id, p, noon(p.paidOn));
    logActivity(this.ctx, { contactId: c.id, shootId: shootRow?.id ?? null, kind: "invoice.imported", summary: `Invoice imported from ${this.opts.source}: ${title}` });
    this.remember("invoice", key, id);
    this.report.created.invoices++;
    if (!shootRow && shootName) notes.push(`No shoot called “${shootName}” found, so it isn't linked to one.`);
    return { action: "create", label: `${label}: ${title}`, notes: [...notes, `${pays.length} payment${pays.length === 1 ? "" : "s"}.`] };
  }

  private addPayment(orderId: string, p: { cents: number; method: ReturnType<typeof mapMethod>; ref: string }, at: number) {
    this.ctx.db.insert(payment).values({ id: newId(), orderId, amountCents: p.cents, method: p.method, provider: "import", providerRef: p.ref, note: `Imported from ${this.opts.source}`, paidAt: new Date(at) }).run();
    this.report.created.payments++;
  }

  /** If imported payments now exceed the total, raise the total so the invoice never shows a negative balance. */
  private bumpTotal(orderId: string) {
    const paid = this.ctx.db.select({ n: sql<number>`coalesce(sum(${payment.amountCents}), 0)` }).from(payment).where(eq(payment.orderId, orderId)).get()?.n ?? 0;
    const o = this.ctx.db.select({ total: order.totalCents }).from(order).where(eq(order.id, orderId)).get();
    if (o && paid > o.total) {
      this.ctx.db.update(order).set({ totalCents: paid, subtotalCents: paid }).where(eq(order.id, orderId)).run();
      this.ctx.db.update(orderLine).set({ unitCents: paid }).where(eq(orderLine.orderId, orderId)).run();
      this.ctx.db.update(paymentSchedule).set({ amountCents: paid }).where(eq(paymentSchedule.orderId, orderId)).run();
    }
  }
}
