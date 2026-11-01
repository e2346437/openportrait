import type { ServiceContext } from "../domain/context.js";
import type { Settings } from "../settings.js";

/** Who makes an automation's decisions: OpenPortrait's own schedulers, the connected AI, or nobody. */
export type Owner = "built-in" | "ai" | "off";
export type Mode = "built-in" | "ai";

export interface WorkItem {
  id: string;
  automation: string;
  title: string;
  detail: string;
  ref: { type: "lead" | "shoot" | "contact"; id: string };
  /** When this started needing attention (ms). */
  since: number;
}

export interface AutomationDef {
  id: string;
  title: string;
  description: string;
  /** What needs a decision right now. The AI sees these when it owns the automation. */
  items(ctx: ServiceContext): WorkItem[];
}

const automations = new Map<string, AutomationDef>();

/** Feature modules register the routine decisions they would otherwise automate. Plumbing (confirmations, sync, backups) is never registered, so it always runs. */
export function defineAutomation(def: AutomationDef): AutomationDef {
  if (automations.has(def.id)) throw new Error(`Duplicate automation: ${def.id}`);
  automations.set(def.id, def);
  return def;
}

export const allAutomations = () => [...automations.values()];

export const modeOf = (settings: Settings): Mode => settings.get("automation.mode") ?? "built-in";

/** The override for this automation, or the studio-wide mode. */
export function ownerOf(settings: Settings, id: string): Owner {
  return settings.get("automation.overrides")?.[id] ?? modeOf(settings);
}

/**
 * Built-in schedulers must ask this before acting. When the AI (or nobody) owns the automation the
 * built-in rule stays quiet, so the same decision is never made twice.
 */
export const builtInMayRun = (settings: Settings, id: string) => ownerOf(settings, id) === "built-in";
