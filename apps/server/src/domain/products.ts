import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";

const { catalogItem } = tables;

export interface ItemInput {
  kind?: "package" | "item";
  name: string;
  description?: string | null;
  priceCents: number;
  taxable?: boolean;
}

function clean(input: ItemInput) {
  const name = input.name.trim();
  if (!name) throw new DomainError("invalid", "Give it a name.");
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 100_000_000) throw new DomainError("invalid", "Enter a price of zero or more.");
  return { kind: input.kind ?? "item", name: name.slice(0, 200), description: input.description?.trim().slice(0, 1000) || null, priceCents: input.priceCents, taxable: input.taxable ?? true };
}

export function listItems(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}) {
  return ctx.db
    .select()
    .from(catalogItem)
    .where(opts.includeArchived ? undefined : isNull(catalogItem.archivedAt))
    .orderBy(desc(catalogItem.kind), asc(catalogItem.position), asc(catalogItem.name))
    .all();
}

function row(ctx: ServiceContext, id: string) {
  const r = ctx.db.select().from(catalogItem).where(eq(catalogItem.id, id)).get();
  if (!r) throw notFound("That item");
  return r;
}

export function createItem(ctx: ServiceContext, input: ItemInput) {
  const id = newId();
  const position = ctx.db.select({ id: catalogItem.id }).from(catalogItem).where(and(isNull(catalogItem.archivedAt))).all().length;
  ctx.db.insert(catalogItem).values({ id, position, ...clean(input) }).run();
  return row(ctx, id);
}

export function updateItem(ctx: ServiceContext, id: string, input: ItemInput) {
  row(ctx, id);
  ctx.db.update(catalogItem).set(clean(input)).where(eq(catalogItem.id, id)).run();
  return row(ctx, id);
}

/** Items on past quotes keep their own copy of the name and price, so archiving is always safe. */
export function archiveItem(ctx: ServiceContext, id: string, archived = true) {
  row(ctx, id);
  ctx.db.update(catalogItem).set({ archivedAt: archived ? new Date() : null }).where(eq(catalogItem.id, id)).run();
  return row(ctx, id);
}
