import type { z } from "zod";
import type { AppContext } from "../app.js";

/** Areas a connection can be limited to. Feature modules add their own when they register tools. */
export const AREAS = ["studio", "contacts", "leads", "shoots", "calendar", "quotes", "orders", "galleries", "email"] as const;
export type Area = (typeof AREAS)[number];

/** What a tool can do, in increasing order of consequence (see SPEC section 10). */
export type Tier = "read" | "draft" | "outward" | "money";
export type Level = "read" | "assist" | "full";

export interface Caller {
  connectionId: string;
  label: string;
  level: Level;
  areas: string[];
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case with the area first, for example `studio_get_summary`. */
  name: string;
  title: string;
  description: string;
  area: Area;
  tier: Tier;
  /** Which switchable group this tool belongs to. Groups can be turned off as a whole (see setCapabilityEnabled). */
  capability?: string;
  /** Outward and money tools must say in plain words what they will do, shown to the owner for approval. */
  summarize?(args: z.infer<z.ZodObject<S>>): string;
  input: S;
  handler(ctx: AppContext, args: z.infer<z.ZodObject<S>>, caller: Caller): unknown | Promise<unknown>;
}

const tools = new Map<string, ToolDef>();

/** Feature modules call this next to their routes. A feature isn't done until its tools exist. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  if (tools.has(def.name)) throw new Error(`Duplicate MCP tool: ${def.name}`);
  tools.set(def.name, def as unknown as ToolDef);
  return def;
}

export function allTools(): ToolDef[] {
  return [...tools.values()];
}

/**
 * Which tiers a level may ask for. Read-only connections see only read tools. Everything that reaches a
 * client or touches money is queued for the owner's approval.
 */
const TIERS: Record<Level, Tier[]> = { read: ["read"], assist: ["read", "draft", "outward", "money"], full: ["read", "draft", "outward", "money"] };

/** Outward and money tools never run straight away: they are queued for the owner's approval. */
export const needsApproval = (t: Pick<ToolDef, "tier">) => t.tier === "outward" || t.tier === "money";

const disabledCapabilities = new Set<string>();
const lockedCapabilities = new Set<string>();
const grantedCapabilities = new Set<string>();

/** Marks a group as available only once an extension grants it. Core calls this at startup for groups that extensions provide. */
export function lockCapability(id: string): void {
  lockedCapabilities.add(id);
}
/** Extensions call these through their API to switch a locked group on or off. */
export function grantCapability(id: string): void {
  grantedCapabilities.add(id);
}
export function revokeCapability(id: string): void {
  grantedCapabilities.delete(id);
}
export const isCapabilityAvailable = (id: string) => !disabledCapabilities.has(id) && (!lockedCapabilities.has(id) || grantedCapabilities.has(id));
/** Switches a whole group of tools off (or back on). Tools without a capability are always available. */
export function setCapabilityEnabled(id: string, enabled: boolean): void {
  if (enabled) disabledCapabilities.delete(id);
  else disabledCapabilities.add(id);
}

export function toolsFor(caller: Pick<Caller, "level" | "areas">): ToolDef[] {
  return allTools().filter((t) => TIERS[caller.level].includes(t.tier) && caller.areas.includes(t.area) && !(t.capability && !isCapabilityAvailable(t.capability)));
}

export const findTool = (name: string) => tools.get(name);
