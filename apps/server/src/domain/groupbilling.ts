import path from "node:path";
import { and, asc, eq, inArray, like, ne, or } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { resolveInside } from "./folders.js";
import { totalsFor } from "./money.js";
import { getOrder, rebalance, createOrder, updateOrder, type OrderLineInput } from "./orders.js";
import { folderSettings, listChildren } from "./shoots.js";
import { scanPhotos } from "./tether.js";

const { shoot, shootCost, order, gallery } = tables;

export type Split = "per_party" | "per_person";

/** Divides `total` cents into `n` shares that add up exactly: the first few shares carry the leftover cents. */
export function splitCents(total: number, n: number): number[] {
  if (n < 1) return [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Splits `total` in proportion to whole-number weights (a family of four pays four shares), still summing exactly. */
export function splitByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum < 1) return [];
  const raw = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - raw.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % raw.length, left--) raw[i]! += 1;
  return raw;
}

function day(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(shoot).where(eq(shoot.id, id)).get();
  if (!row) throw notFound("Shoot");
  if (row.kind !== "group_day") throw new DomainError("invalid", "Make this shoot a group day first.");
  return row;
}

export function listCosts(ctx: ServiceContext, dayId: string) {
  return ctx.db.select().from(shootCost).where(eq(shootCost.shootId, dayId)).orderBy(asc(shootCost.position), asc(shootCost.createdAt)).all();
}

export function addCost(ctx: ServiceContext, dayId: string, input: { label: string; amountCents: number }) {
  day(ctx, dayId);
  const label = input.label.trim();
  if (!label) throw new DomainError("invalid", "Name the cost, such as “Location fee”.");
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0 || input.amountCents > 100_000_000) throw new DomainError("invalid", "Enter the cost as an amount of zero or more.");
  const position = listCosts(ctx, dayId).length;
  ctx.db.insert(shootCost).values({ id: newId(), shootId: dayId, label: label.slice(0, 120), amountCents: input.amountCents, position }).run();
  return listCosts(ctx, dayId);
}

export function removeCost(ctx: ServiceContext, dayId: string, costId: string) {
  day(ctx, dayId);
  ctx.db.delete(shootCost).where(and(eq(shootCost.id, costId), eq(shootCost.shootId, dayId))).run();
  return listCosts(ctx, dayId);
}

/** Camera files saved under a person's own folder. Someone with none wasn't photographed, so isn't charged. */
function framesFor(ctx: ServiceContext, folderPath: string | null): number {
  if (!folderPath) return 0;
  try {
    return scanPhotos(resolveInside(ctx.config.galleriesDir, path.posix.join(folderPath, folderSettings(ctx).rawSubdir))).length;
  } catch {
    return 0;
  }
}

export function dayBilling(ctx: ServiceContext, dayId: string, split: Split = "per_party") {
  day(ctx, dayId);
  const costs = listCosts(ctx, dayId);
  const totalCostCents = costs.reduce((n, c) => n + c.amountCents, 0);
  const kids = ctx.db.select({ id: shoot.id, headcount: shoot.headcount }).from(shoot).where(eq(shoot.parentId, dayId)).all();
  const heads = new Map(kids.map((k) => [k.id, k.headcount]));
  const people = listChildren(ctx, dayId).map((c) => ({ ...c, headcount: heads.get(c.id) ?? 1, frames: framesFor(ctx, c.folderPath) }));
  const billable = people.filter((p) => p.billTo === "self" && p.frames > 0);
  const shares = split === "per_person" ? splitByWeight(totalCostCents, billable.map((p) => p.headcount)) : splitCents(totalCostCents, billable.length);
  const covered = people.filter((p) => p.billTo === "parent" && p.frames > 0).length;
  const invoiced = new Set(
    ctx.db
      .select({ shootId: order.shootId })
      .from(order)
      .where(and(inArray(order.shootId, people.length ? people.map((p) => p.id) : [""]), ne(order.status, "void")))
      .all()
      .map((o) => o.shootId),
  );
  return {
    costs: costs.map((c) => ({ id: c.id, label: c.label, amountCents: c.amountCents })),
    totalCostCents,
    split,
    /** People on the day's own invoice. */
    coveredCount: covered,
    people: people.map((p) => ({ id: p.id, subject: p.subject, billTo: p.billTo, headcount: p.headcount, frames: p.frames, hasInvoice: invoiced.has(p.id), shareCents: billable.indexOf(p) >= 0 ? (shares[billable.indexOf(p)] ?? 0) : 0 })),
    billableCount: billable.length,
  };
}

/** One draft invoice per photographed person who is billed on their own, each with their share of the shared costs. */
export function createChildInvoices(ctx: ServiceContext, dayId: string, input: { lines: OrderLineInput[]; split?: Split; only?: string[]; costLabel?: string }) {
  const parent = day(ctx, dayId);
  if (!input.lines.length) throw new DomainError("invalid", "Add at least one line, such as the session fee.");
  const summary = dayBilling(ctx, dayId, input.split ?? "per_party");
  const chosen = summary.people.filter((p) => p.billTo === "self" && p.frames > 0 && (!input.only || input.only.includes(p.id)));
  const created: Array<{ shootId: string; subject: string; orderId: string; totalCents: number }> = [];
  const skipped: Array<{ subject: string; reason: string }> = [];
  for (const p of summary.people.filter((x) => !chosen.includes(x))) {
    if (input.only && !input.only.includes(p.id)) continue;
    skipped.push({ subject: p.subject, reason: p.billTo === "parent" ? "Covered by the day's invoice." : "No photos yet." });
  }
  const shares = summary.people.filter((p) => p.billTo === "self" && p.frames > 0);
  for (const p of chosen) {
    if (p.hasInvoice) {
      skipped.push({ subject: p.subject, reason: "Already has an invoice." });
      continue;
    }
    const child = ctx.db.select().from(shoot).where(eq(shoot.id, p.id)).get()!;
    const share = shares.find((s) => s.id === p.id)!.shareCents;
    const lines: OrderLineInput[] = [...input.lines, ...(share > 0 ? [{ description: input.costLabel?.trim() || "Share of location and travel", unitCents: share, quantity: 1 }] : [])];
    const o = createOrder(ctx, "invoice", { contactId: child.primaryContactId, shootId: child.id, title: `${parent.subject}: ${child.subject}`, lines });
    created.push({ shootId: child.id, subject: child.subject, orderId: o.id, totalCents: o.totalCents });
  }
  return { created, skipped };
}

/** Sets a draft invoice's per-person line to the number of people actually photographed on the day it belongs to. */
export function recountDayInvoice(ctx: ServiceContext, orderId: string, lineId: string) {
  const o = getOrder(ctx, orderId);
  if (o.state !== "draft") throw new DomainError("locked", "Only a draft can be recounted. Reopen or void it first.");
  if (!o.shootId) throw new DomainError("invalid", "This invoice isn't attached to a group day.");
  const summary = dayBilling(ctx, o.shootId);
  const count = summary.people.filter((p) => p.billTo === "parent" && p.frames > 0).length;
  if (count < 1) throw new DomainError("invalid", "Nobody covered by this invoice has been photographed yet.");
  if (!o.lines.some((l) => l.id === lineId)) throw new DomainError("not_found", "That line isn't on this invoice.", 404);
  const lines = o.lines.map((l) => ({ itemId: l.itemId, description: l.description, detail: l.detail, quantity: l.id === lineId ? count : l.quantity, unitCents: l.unitCents, taxable: l.taxable }));
  const totals = totalsFor(lines, o.discountCents + o.couponCents, o.taxBps);
  const schedule = rebalance(o.schedule.map((s) => ({ label: s.label, amountCents: s.amountCents, dueDate: s.dueDate })), totals.totalCents);
  const row = ctx.db.select().from(order).where(eq(order.id, orderId)).get()!;
  const next = updateOrder(ctx, orderId, { contactId: row.contactId, shootId: row.shootId, leadId: row.leadId, title: o.title, intro: o.intro, terms: o.terms, discountCents: o.discountCents, couponCode: o.couponCode, validUntil: o.validUntil, taxRateId: o.taxRateId, lines, schedule });
  return { order: next, count };
}

/** Lifts the download lock on every gallery for people on this day. Used once the day's invoice is paid. */
export function unlockDayGalleries(ctx: ServiceContext, dayId: string) {
  day(ctx, dayId);
  const kids = listChildren(ctx, dayId);
  if (!kids.length) return { unlocked: 0 };
  const folders = kids.map((k) => k.folderPath).filter((f): f is string => !!f);
  const rows = ctx.db
    .select({ id: gallery.id, unlockedAt: gallery.unlockedAt })
    .from(gallery)
    .where(or(inArray(gallery.shootId, kids.map((k) => k.id)), ...folders.map((f) => like(gallery.shootFolder, `${f.replace(/[\\%_]/g, "\\$&")}%`))))
    .all();
  const todo = rows.filter((g) => !g.unlockedAt);
  for (const g of todo) ctx.db.update(gallery).set({ unlockedAt: new Date() }).where(eq(gallery.id, g.id)).run();
  return { unlocked: todo.length };
}
