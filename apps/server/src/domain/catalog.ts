import { asc, count, eq, isNull, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { DomainError, newId, notFound, type ServiceContext } from "./context.js";

const { shootType, shoot, leadStage, lead } = tables;

// ---- Shoot types ----

export function listShootTypes(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}) {
  return ctx.db
    .select({
      id: shootType.id,
      name: shootType.name,
      folderLabel: shootType.folderLabel,
      autoPublish: shootType.autoPublish,
      position: shootType.position,
      archived: sql<boolean>`${shootType.archivedAt} is not null`,
      shoots: sql<number>`(select count(*) from shoot where shoot.shoot_type_id = ${shootType.id})`,
    })
    .from(shootType)
    .where(opts.includeArchived ? undefined : isNull(shootType.archivedAt))
    .orderBy(asc(shootType.position))
    .all();
}

function typeRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(shootType).where(eq(shootType.id, id)).get();
  if (!row) throw notFound("Shoot type");
  return row;
}

function assertTypeNameFree(ctx: ServiceContext, name: string, exceptId?: string) {
  const clash = ctx.db.select().from(shootType).where(sql`${shootType.name} = ${name} collate nocase and ${shootType.archivedAt} is null`).all();
  if (clash.some((c) => c.id !== exceptId)) throw new DomainError("duplicate", `You already have a shoot type called “${name}”.`);
}

export function createShootType(ctx: ServiceContext, input: { name: string; folderLabel?: string; autoPublish?: boolean }) {
  const name = input.name.trim();
  if (!name) throw new DomainError("invalid", "Give the shoot type a name.");
  assertTypeNameFree(ctx, name);
  const position = (ctx.db.select({ m: sql<number>`coalesce(max(${shootType.position}), -1)` }).from(shootType).get()?.m ?? -1) + 1;
  const id = newId();
  ctx.db.insert(shootType).values({ id, name, folderLabel: input.folderLabel?.trim() || name, autoPublish: input.autoPublish ?? false, position }).run();
  return typeRow(ctx, id);
}

export function updateShootType(ctx: ServiceContext, id: string, input: { name?: string; folderLabel?: string; autoPublish?: boolean }) {
  const current = typeRow(ctx, id);
  const patch: Partial<typeof shootType.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new DomainError("invalid", "Give the shoot type a name.");
    assertTypeNameFree(ctx, name, id);
    patch.name = name;
    // The folder word follows the name until someone sets it on purpose.
    if (input.folderLabel === undefined && current.folderLabel === current.name) patch.folderLabel = name;
  }
  if (input.folderLabel !== undefined) patch.folderLabel = input.folderLabel.trim() || patch.name || current.name;
  if (input.autoPublish !== undefined) patch.autoPublish = input.autoPublish;
  if (Object.keys(patch).length) ctx.db.update(shootType).set(patch).where(eq(shootType.id, id)).run();
  return typeRow(ctx, id);
}

/** Types that shoots use are archived (hidden from pickers); unused ones are deleted. */
export function removeShootType(ctx: ServiceContext, id: string): "archived" | "deleted" {
  typeRow(ctx, id);
  const active = ctx.db.select({ n: count() }).from(shootType).where(isNull(shootType.archivedAt)).get()?.n ?? 0;
  if (active <= 1) throw new DomainError("last_one", "Keep at least one shoot type.");
  const used = ctx.db.select({ n: count() }).from(shoot).where(eq(shoot.shootTypeId, id)).get()?.n ?? 0;
  const leads = ctx.db.select({ n: count() }).from(lead).where(eq(lead.shootTypeId, id)).get()?.n ?? 0;
  if (used > 0 || leads > 0) {
    ctx.db.update(shootType).set({ archivedAt: new Date() }).where(eq(shootType.id, id)).run();
    return "archived";
  }
  ctx.db.delete(shootType).where(eq(shootType.id, id)).run();
  return "deleted";
}

export function reorderShootTypes(ctx: ServiceContext, ids: string[]) {
  ctx.db.transaction((tx) => {
    ids.forEach((id, position) => tx.update(shootType).set({ position }).where(eq(shootType.id, id)).run());
  });
  return listShootTypes(ctx);
}

// ---- Lead stages ----

export function listStages(ctx: ServiceContext) {
  return ctx.db
    .select({ id: leadStage.id, name: leadStage.name, kind: leadStage.kind, position: leadStage.position, leads: sql<number>`(select count(*) from lead where lead.stage_id = ${leadStage.id})` })
    .from(leadStage)
    .orderBy(asc(leadStage.position))
    .all();
}

function stageRow(ctx: ServiceContext, id: string) {
  const row = ctx.db.select().from(leadStage).where(eq(leadStage.id, id)).get();
  if (!row) throw notFound("Stage");
  return row;
}

/** New stages are always open ones, and go just before the Booked column. */
export function createStage(ctx: ServiceContext, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError("invalid", "Give the stage a name.");
  const id = newId();
  ctx.db.transaction((tx) => {
    const stages = tx.select().from(leadStage).orderBy(asc(leadStage.position)).all();
    const firstClosed = stages.find((s) => s.kind !== "open");
    const position = firstClosed ? firstClosed.position : stages.length;
    for (const s of stages.filter((s) => s.position >= position)) tx.update(leadStage).set({ position: s.position + 1 }).where(eq(leadStage.id, s.id)).run();
    tx.insert(leadStage).values({ id, name: trimmed, kind: "open", position }).run();
  });
  return stageRow(ctx, id);
}

export function renameStage(ctx: ServiceContext, id: string, name: string) {
  stageRow(ctx, id);
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError("invalid", "Give the stage a name.");
  ctx.db.update(leadStage).set({ name: trimmed }).where(eq(leadStage.id, id)).run();
  return stageRow(ctx, id);
}

export function removeStage(ctx: ServiceContext, id: string) {
  const stage = stageRow(ctx, id);
  if (stage.kind !== "open") throw new DomainError("protected", `“${stage.name}” is how OpenPortrait knows a lead was won or lost, so it can be renamed but not removed.`);
  const leads = ctx.db.select({ n: count() }).from(lead).where(eq(lead.stageId, id)).get()?.n ?? 0;
  if (leads > 0) throw new DomainError("not_empty", `Move the ${leads} lead${leads === 1 ? "" : "s"} in “${stage.name}” to another stage first.`);
  const open = ctx.db.select({ n: count() }).from(leadStage).where(eq(leadStage.kind, "open")).get()?.n ?? 0;
  if (open <= 1) throw new DomainError("last_one", "Keep at least one open stage.");
  ctx.db.delete(leadStage).where(eq(leadStage.id, id)).run();
}

/** Open stages can be reordered; Booked and Lost always stay at the end. */
export function reorderStages(ctx: ServiceContext, openIds: string[]) {
  const stages = listStages(ctx);
  const open = stages.filter((s) => s.kind === "open").map((s) => s.id);
  if (openIds.length !== open.length || !openIds.every((id) => open.includes(id))) throw new DomainError("invalid", "Send every open stage exactly once.");
  const closed = stages.filter((s) => s.kind !== "open").map((s) => s.id);
  ctx.db.transaction((tx) => {
    [...openIds, ...closed].forEach((id, position) => tx.update(leadStage).set({ position }).where(eq(leadStage.id, id)).run());
  });
  return listStages(ctx);
}
