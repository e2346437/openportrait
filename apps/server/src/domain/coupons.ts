import { and, asc, eq, ne, notInArray, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";
import { formatMoney } from "./money.js";
import { isYmd, ymdIn } from "./time.js";

const { coupon, order, catalogItem, scheduler } = tables;

export type CouponRow = typeof coupon.$inferSelect;

export interface CouponInput {
  code: string;
  description?: string | null;
  kind: "percent" | "fixed";
  /** Percent: basis points (1000 = 10%). Fixed: cents. */
  value: number;
  itemId?: string | null;
  /** Limit the coupon to one booking page. */
  schedulerId?: string | null;
  expiresOn?: string | null;
  maxUses?: number | null;
  active?: boolean;
}

export const normalizeCode = (raw: string) => raw.trim().toUpperCase().replace(/\s+/g, "");

const usesOf = (ctx: ServiceContext, couponId: string, exceptOrderId?: string) =>
  ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(order)
    .where(and(eq(order.couponId, couponId), notInArray(order.status, ["void", "declined"]), exceptOrderId ? ne(order.id, exceptOrderId) : undefined))
    .get()?.n ?? 0;

function describe(ctx: ServiceContext, c: CouponRow) {
  const cur = ctx.settings.get("money.currency") || "USD";
  const what = c.kind === "percent" ? `${c.value / 100}% off` : `${formatMoney(c.value, cur)} off`;
  const item = c.itemId ? ctx.db.select({ name: catalogItem.name }).from(catalogItem).where(eq(catalogItem.id, c.itemId)).get()?.name : null;
  const page = c.schedulerId ? schedulerName(ctx, c.schedulerId) : null;
  return [item ? `${what} ${item}` : what, page ? `on ${page}` : null].filter(Boolean).join(" ");
}

const schedulerName = (ctx: ServiceContext, id: string) => ctx.db.select({ name: scheduler.name }).from(scheduler).where(eq(scheduler.id, id)).get()?.name ?? null;

function present(ctx: ServiceContext, c: CouponRow) {
  const uses = usesOf(ctx, c.id);
  return { ...c, uses, summary: describe(ctx, c), schedulerName: c.schedulerId ? schedulerName(ctx, c.schedulerId) : null, itemName: c.itemId ? ctx.db.select({ name: catalogItem.name }).from(catalogItem).where(eq(catalogItem.id, c.itemId)).get()?.name ?? null : null };
}

export function listCoupons(ctx: ServiceContext) {
  return ctx.db.select().from(coupon).orderBy(asc(coupon.code)).all().map((c) => present(ctx, c));
}

function validate(ctx: ServiceContext, input: CouponInput) {
  const code = normalizeCode(input.code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new DomainError("invalid", "Use 3 to 32 letters, numbers, dashes or underscores for the code, such as SPRING25.");
  if (!Number.isInteger(input.value) || input.value <= 0) throw new DomainError("invalid", "Enter how much the coupon takes off.");
  if (input.kind === "percent" && input.value > 10_000) throw new DomainError("invalid", "A percentage can't be more than 100.");
  if (input.expiresOn && !isYmd(input.expiresOn)) throw new DomainError("invalid", "Enter the expiry date as year-month-day.");
  if (input.maxUses != null && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) throw new DomainError("invalid", "The use limit must be a whole number of 1 or more, or left empty.");
  if (input.itemId && !ctx.db.select({ id: catalogItem.id }).from(catalogItem).where(eq(catalogItem.id, input.itemId)).get()) throw new DomainError("invalid", "That product isn't in your price list.");
  if (input.schedulerId && !ctx.db.select({ id: scheduler.id }).from(scheduler).where(eq(scheduler.id, input.schedulerId)).get()) throw new DomainError("invalid", "That booking page doesn't exist.");
  return { code, description: input.description?.trim().slice(0, 300) || null, kind: input.kind, value: input.value, itemId: input.itemId || null, schedulerId: input.schedulerId || null, expiresOn: input.expiresOn || null, maxUses: input.maxUses ?? null, active: input.active ?? true };
}

export function createCoupon(ctx: ServiceContext, input: CouponInput) {
  const v = validate(ctx, input);
  if (ctx.db.select({ id: coupon.id }).from(coupon).where(eq(coupon.code, v.code)).get()) throw new DomainError("conflict", `There is already a coupon called ${v.code}.`, 409);
  const id = newId();
  ctx.db.insert(coupon).values({ id, ...v }).run();
  return present(ctx, ctx.db.select().from(coupon).where(eq(coupon.id, id)).get()!);
}

export function updateCoupon(ctx: ServiceContext, id: string, input: CouponInput) {
  if (!ctx.db.select({ id: coupon.id }).from(coupon).where(eq(coupon.id, id)).get()) throw notFound("Coupon");
  const v = validate(ctx, input);
  const clash = ctx.db.select({ id: coupon.id }).from(coupon).where(and(eq(coupon.code, v.code), ne(coupon.id, id))).get();
  if (clash) throw new DomainError("conflict", `There is already a coupon called ${v.code}.`, 409);
  ctx.db.update(coupon).set(v).where(eq(coupon.id, id)).run();
  return present(ctx, ctx.db.select().from(coupon).where(eq(coupon.id, id)).get()!);
}

/** A coupon that has been used stays in the books: it is switched off instead of removed. */
export function deleteCoupon(ctx: ServiceContext, id: string) {
  const c = ctx.db.select().from(coupon).where(eq(coupon.id, id)).get();
  if (!c) throw notFound("Coupon");
  const used = ctx.db.select({ id: order.id }).from(order).where(eq(order.couponId, id)).get();
  if (used) {
    ctx.db.update(coupon).set({ active: false }).where(eq(coupon.id, id)).run();
    return { removed: false, deactivated: true };
  }
  ctx.db.delete(coupon).where(eq(coupon.id, id)).run();
  return { removed: true, deactivated: false };
}

export interface Applied {
  couponId: string;
  code: string;
  cents: number;
}

/**
 * Works out what a coupon takes off these lines. A coupon already on the document keeps working as promised
 * (even if it has since expired or hit its limit) but its amount follows the lines. A new code is fully checked.
 */
export function evaluate(
  ctx: ServiceContext,
  rawCode: string,
  lines: Array<{ itemId: string | null; quantity: number; unitCents: number }>,
  opts: { orderId?: string; keepCouponId?: string | null; manualDiscountCents: number; schedulerId?: string | null },
): Applied {
  const code = normalizeCode(rawCode);
  const c = ctx.db.select().from(coupon).where(eq(coupon.code, code)).get();
  if (!c) throw new DomainError("invalid", `We don't have a coupon called ${code}. Check the spelling.`);
  const keeping = opts.keepCouponId === c.id;
  if (!keeping) {
    if (c.schedulerId && c.schedulerId !== (opts.schedulerId ?? null)) throw new DomainError("invalid", `${c.code} only works on one booking page.`);
    if (!c.active) throw new DomainError("invalid", `${c.code} isn't active.`);
    if (c.expiresOn && c.expiresOn < ymdIn(Date.now(), ctx.settings.get("studio.timezone") ?? "UTC")) throw new DomainError("invalid", `${c.code} expired on ${c.expiresOn}.`);
    if (c.maxUses != null && usesOf(ctx, c.id, opts.orderId) >= c.maxUses) throw new DomainError("invalid", `${c.code} has been used the most times it can be.`);
  }
  const eligible = lines.filter((l) => !c.itemId || l.itemId === c.itemId).reduce((n, l) => n + l.quantity * l.unitCents, 0);
  if (eligible <= 0) throw new DomainError("invalid", c.itemId ? `${c.code} only applies to a specific product, and it isn't on this list.` : `${c.code} has nothing to take money off.`);
  const raw = c.kind === "percent" ? Math.round((eligible * c.value) / 10_000) : Math.min(c.value, eligible);
  const subtotal = lines.reduce((n, l) => n + l.quantity * l.unitCents, 0);
  const cents = Math.max(0, Math.min(raw, subtotal - Math.min(opts.manualDiscountCents, subtotal)));
  return { couponId: c.id, code: c.code, cents };
}
