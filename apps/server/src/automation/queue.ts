import { pendingCount } from "../ai/approvals.js";
import type { AppContext } from "../app.js";
import type { ServiceContext } from "../domain/context.js";
import "./automations.js";
import { allAutomations, modeOf, ownerOf, type Owner, type WorkItem } from "./registry.js";

const svc = (ctx: AppContext): ServiceContext => ({ db: ctx.db, settings: ctx.settings, config: ctx.config, actorId: null });

/** What needs doing, across every automation the AI owns. Oldest first. */
export function workQueue(ctx: AppContext): WorkItem[] {
  const s = svc(ctx);
  return allAutomations()
    .filter((a) => ownerOf(ctx.settings, a.id) === "ai")
    .flatMap((a) => a.items(s))
    .sort((a, b) => a.since - b.since)
    .slice(0, 50);
}

/**
 * What needs the owner's attention, across every automation the built-in rules own. These are in-app
 * reminders only: nothing is sent to a client and nothing is changed. Oldest first.
 */
export function reminders(ctx: AppContext): WorkItem[] {
  const s = svc(ctx);
  return allAutomations()
    .filter((a) => ownerOf(ctx.settings, a.id) === "built-in")
    .flatMap((a) => a.items(s))
    .sort((a, b) => a.since - b.since)
    .slice(0, 50);
}

export function recordCheckin(ctx: AppContext): void {
  ctx.settings.set("automation.lastAiCheckinAt", Date.now());
}

export function automationStatus(ctx: AppContext) {
  const mode = modeOf(ctx.settings);
  const windowHours = ctx.settings.get("automation.aiCheckinWindowHours") ?? 24;
  const lastCheckinAt = ctx.settings.get("automation.lastAiCheckinAt") ?? null;
  const items = allAutomations().map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    owner: ownerOf(ctx.settings, a.id) as Owner,
    overridden: ctx.settings.get("automation.overrides")?.[a.id] !== undefined,
    waiting: ownerOf(ctx.settings, a.id) === "ai" ? a.items(svc(ctx)).length : 0,
    reminders: ownerOf(ctx.settings, a.id) === "built-in" ? a.items(svc(ctx)).length : 0,
  }));
  const aiOwns = items.some((i) => i.owner === "ai");
  const queueSize = items.reduce((n, i) => n + i.waiting, 0);
  // Warn (never act) when the AI owns work but hasn't looked in a while.
  const stale = aiOwns && queueSize > 0 && (!lastCheckinAt || Date.now() - lastCheckinAt > windowHours * 3_600_000);
  return {
    mode,
    windowHours,
    lastCheckinAt,
    stale,
    queueSize,
    pendingApprovals: pendingCount(ctx),
    aiAccessEnabled: ctx.settings.get("ai.enabled") ?? false,
    automations: items,
  };
}
