import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";

const { catalogItem, catalogPackageItem } = tables;

export interface ItemInput {
  kind?: "package" | "item";
  name: string;
  description?: string | null;
  priceCents: number;
  taxable?: boolean;
  /** Packages only: the products inside, with how many of each. */
  components?: { itemId: string; quantity: number }[];
  /** Packages only: price is the sum of the components. */
  autoPrice?: boolean;
}

function clean(input: ItemInput) {
  const name = input.name.trim();
  if (!name) throw new DomainError("invalid", "Give it a name.");
  const kind = input.kind ?? "item";
  const auto = kind === "package" && !!input.autoPrice && (input.components?.length ?? 0) > 0;
  if (!auto && (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 100_000_000)) throw new DomainError("invalid", "Enter a price of zero or more.");
  return { kind, name: name.slice(0, 200), description: input.description?.trim().slice(0, 1000) || null, priceCents: auto ? 0 : input.priceCents, taxable: input.taxable ?? true, autoPrice: auto };
}

type Component = { itemId: string; quantity: number };

function cleanComponents(ctx: ServiceContext, input: ItemInput): Component[] {
  if ((input.kind ?? "item") !== "package") return [];
  const seen = new Set<string>();
  const out: Component[] = [];
  for (const c of input.components ?? []) {
    if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 99) throw new DomainError("invalid", "Use a quantity from 1 to 99.");
    if (seen.has(c.itemId)) throw new DomainError("invalid", "A product can only be listed once in a package.");
    seen.add(c.itemId);
    const p = ctx.db.select().from(catalogItem).where(eq(catalogItem.id, c.itemId)).get();
    if (!p || p.archivedAt || p.kind !== "item") throw new DomainError("invalid", "Packages are built from active products.");
    out.push({ itemId: c.itemId, quantity: c.quantity });
  }
  return out;
}

function setComponents(ctx: ServiceContext, packageId: string, comps: Component[]) {
  ctx.db.delete(catalogPackageItem).where(eq(catalogPackageItem.packageId, packageId)).run();
  comps.forEach((c, position) => ctx.db.insert(catalogPackageItem).values({ packageId, ...c, position }).run());
}

/** Auto-priced packages are always the sum of their products, kept in the stored price so quotes and the AI see one number. */
function reprice(ctx: ServiceContext) {
  const items = ctx.db.select().from(catalogItem).all();
  const byId = new Map(items.map((i) => [i.id, i]));
  const comps = ctx.db.select().from(catalogPackageItem).all();
  for (const pkg of items.filter((i) => i.autoPrice)) {
    const total = comps.filter((c) => c.packageId === pkg.id).reduce((n, c) => n + (byId.get(c.itemId)?.priceCents ?? 0) * c.quantity, 0);
    if (total !== pkg.priceCents) ctx.db.update(catalogItem).set({ priceCents: total }).where(eq(catalogItem.id, pkg.id)).run();
  }
}

export function listItems(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}) {
  const items = ctx.db
    .select()
    .from(catalogItem)
    .where(opts.includeArchived ? undefined : isNull(catalogItem.archivedAt))
    .orderBy(desc(catalogItem.kind), asc(catalogItem.position), asc(catalogItem.name))
    .all();
  const comps = ctx.db.select().from(catalogPackageItem).orderBy(asc(catalogPackageItem.position)).all();
  return items.map((i) => ({ ...i, components: i.kind === "package" ? comps.filter((c) => c.packageId === i.id).map((c) => ({ itemId: c.itemId, quantity: c.quantity })) : [] }));
}

function row(ctx: ServiceContext, id: string) {
  const r = ctx.db.select().from(catalogItem).where(eq(catalogItem.id, id)).get();
  if (!r) throw notFound("That item");
  return r;
}

export function createItem(ctx: ServiceContext, input: ItemInput) {
  const id = newId();
  const position = ctx.db.select({ id: catalogItem.id }).from(catalogItem).where(and(isNull(catalogItem.archivedAt))).all().length;
  const values = clean(input);
  const comps = cleanComponents(ctx, input);
  ctx.db.insert(catalogItem).values({ id, position, ...values }).run();
  setComponents(ctx, id, comps);
  reprice(ctx);
  return row(ctx, id);
}

export function updateItem(ctx: ServiceContext, id: string, input: ItemInput) {
  const existing = row(ctx, id);
  const values = clean({ ...input, kind: existing.kind });
  const comps = cleanComponents(ctx, { ...input, kind: existing.kind });
  if (comps.some((c) => c.itemId === id)) throw new DomainError("invalid", "A package cannot contain itself.");
  ctx.db.update(catalogItem).set(values).where(eq(catalogItem.id, id)).run();
  if (existing.kind === "package") setComponents(ctx, id, comps);
  reprice(ctx);
  return row(ctx, id);
}

/** Items on past quotes keep their own copy of the name and price, so archiving is always safe. */
export function archiveItem(ctx: ServiceContext, id: string, archived = true) {
  row(ctx, id);
  ctx.db.update(catalogItem).set({ archivedAt: archived ? new Date() : null }).where(eq(catalogItem.id, id)).run();
  return row(ctx, id);
}
