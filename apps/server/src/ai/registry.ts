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
 * Which tiers a level may call directly. Outward and money tools wait for the owner's approval
 * (the approval queue arrives in step 3), so until then they are not offered to any connection.
 */
const TIERS: Record<Level, Tier[]> = { read: ["read"], assist: ["read", "draft"], full: ["read", "draft"] };

export function toolsFor(caller: Pick<Caller, "level" | "areas">): ToolDef[] {
  return allTools().filter((t) => TIERS[caller.level].includes(t.tier) && caller.areas.includes(t.area));
}
