import crypto from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app.js";

/** Areas a connection can be limited to. Feature modules add their own when they register tools. */
export const AREAS = ["studio", "contacts", "leads", "shoots", "calendar", "quotes", "orders", "contracts", "galleries", "email"] as const;
export type Area = (typeof AREAS)[number];

/** What a tool can do, in increasing order of consequence (see SPEC section 10). */
export type Tier = "read" | "draft" | "outward" | "money" | "sensitive";
export type Level = "read" | "assist" | "full";

/**
 * What a tool does to the world, independent of its tier:
 * - `read-existing` reads one record that must already exist (a `_get` by id).
 * - `read` reads, lists, searches or summarizes, and changes nothing.
 * - `write` changes studio data and reaches nobody outside.
 * - `outbound` reaches a client or goes public.
 * The effect must agree with the tier (see EFFECTS_FOR_TIER), so a tool can't be registered as a harmless draft while it sends.
 */
export type ToolEffect = "read-existing" | "read" | "write" | "outbound";

const EFFECTS_FOR_TIER: Record<Tier, readonly ToolEffect[]> = {
  read: ["read-existing", "read"],
  draft: ["write"],
  outward: ["outbound"],
  money: ["write", "outbound"],
  // Sensitive tools run straight away behind the owner's code, so they can never be outbound: anything that reaches a client waits for approval.
  sensitive: ["write"],
};

/**
 * How a call to a tool may proceed, decided from its effect (and tier) at execution time:
 * - `run`: runs straight away (reads, and draft writes).
 * - `code`: runs straight away, but only once the owner's authorization code has been checked (sensitive writes).
 * - `approve`: never runs straight away; it is queued, and runs only when the owner approves (outbound, and money).
 * A combination that isn't listed has no disposition and is refused, so a new effect is denied until someone decides what it means.
 */
export type Disposition = "run" | "code" | "approve";

export function dispositionFor(tool: Pick<RegisteredTool, "effect" | "tier">): Disposition | null {
  switch (tool.effect) {
    case "read-existing":
    case "read":
      return tool.tier === "read" ? "run" : null;
    case "write":
      return tool.tier === "draft" ? "run" : tool.tier === "sensitive" ? "code" : tool.tier === "money" ? "approve" : null;
    case "outbound":
      return tool.tier === "outward" || tool.tier === "money" ? "approve" : null;
    default:
      return null;
  }
}
/** Used when a registration doesn't say. Picks the most consequential effect its tier allows, never the least. */
const defaultEffect = (tier: Tier): ToolEffect => (tier === "read" ? "read" : tier === "outward" ? "outbound" : "write");

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
  /** What the tool does to the world. Defaults from the tier; set it explicitly. */
  effect?: ToolEffect;
  /** Which switchable group this tool belongs to. Groups can be turned off as a whole (see setCapabilityEnabled). */
  capability?: string;
  /** Outward and money tools must say in plain words what they will do, shown to the owner for approval. */
  summarize?(args: z.infer<z.ZodObject<S>>): string;
  input: S;
  handler(ctx: AppContext, args: z.infer<z.ZodObject<S>>, caller: Caller): unknown | Promise<unknown>;
}

/** A tool as registered: frozen, with the owner that registered it and an identity that changes when its shape does. */
export type RegisteredTool = Readonly<ToolDef> & { readonly effect: ToolEffect; readonly owner: string; readonly fingerprint: string };

/** What a feature policy is shown. Copies only, so a policy can't change a registration or the arguments. */
export interface PolicyRequest {
  tool: { name: string; area: Area; tier: Tier; effect: ToolEffect; capability?: string; owner: string };
  caller: Readonly<Caller>;
  args: Readonly<Record<string, unknown>>;
}
export type PolicyVerdict = boolean | { allow: boolean; message?: string };
/** A generic, synchronous feature gate. It can only restrict: every other check still applies. */
export type FeaturePolicy = (req: PolicyRequest) => PolicyVerdict;

/**
 * Which tiers a level may ask for. Read-only connections see only read tools. Everything that reaches a
 * client or touches money is queued for the owner's approval.
 */
const TIERS: Record<Level, Tier[]> = { read: ["read"], assist: ["read", "draft", "outward", "money"], full: ["read", "draft", "outward", "money", "sensitive"] };
export const tierAllowed = (level: Level, tier: Tier) => TIERS[level]?.includes(tier) ?? false;

/** Sensitive tools run straight away, but only when the call carries the owner's authorization code. */
export const needsCode = (t: Pick<ToolDef, "tier">) => t.tier === "sensitive";

/** Outward and money tools never run straight away: they are queued for the owner's approval. */
export const needsApproval = (t: Pick<ToolDef, "tier">) => t.tier === "outward" || t.tier === "money";

// ---------------------------------------------------------------------------------------------------------------------
// Registry state. Everything an owner (core or one extension) registers is tagged with that owner, so an extension can be
// staged, rolled back and kept from touching what another owner registered.
//
// There are two layers:
// - The built-in definitions (`defineTool` and friends below) are made once, when the tool modules load. They are frozen and
//   shared by every app in the process, and nothing mutates them: each app copies the maps, not the tools.
// - Everything mutable (what extensions register, capability switches, removal counters) lives in one `ToolRegistry` per app,
//   on `ctx.tools`. Two apps in one process (tests, or a restart that overlaps its predecessor) can't see or change each other's.
// ---------------------------------------------------------------------------------------------------------------------

const CORE = "core";

class State {
  tools = new Map<string, RegisteredTool>();
  /** capability id -> owner that locked it. */
  lockedBy = new Map<string, string>();
  /** capability id -> owner that granted it. */
  grantedBy = new Map<string, string>();
  policies: { owner: string; fn: FeaturePolicy }[] = [];
  clone(): State {
    const s = new State();
    s.tools = new Map(this.tools);
    s.lockedBy = new Map(this.lockedBy);
    s.grantedBy = new Map(this.grantedBy);
    s.policies = [...this.policies];
    return s;
  }
}

/** The mutable cell a scope publishes into: the built-in cell at startup, or one app's own. */
interface Cell {
  state: State;
  /**
   * Tool name -> how many times a registration under that name has been removed since this registry was created. It is part
   * of a registration's fingerprint, so removing a tool and registering an identical one again still yields a different
   * identity, and an approval queued for the old registration can't match the new one. It lives for the registry only: a
   * restart starts every tool at 0 again, so an unchanged registration loaded on the next start keeps its fingerprint and
   * the approvals queued for it stay valid. Rollback is the only way a published tool is removed. Built-in tools are never
   * removed, so their fingerprints are the same in every app.
   */
  removals: Map<string, number>;
  /** Switched off by the owner's settings. Not owned by anyone, so rollback never touches it. */
  disabled: Set<string>;
}

function schemaOf(input: z.ZodRawShape): unknown {
  try {
    return z.toJSONSchema(z.object(input), { unrepresentable: "any", io: "input" });
  } catch {
    return Object.keys(input).sort();
  }
}

/** Stable JSON: object keys sorted, so equal values always produce equal text. */
export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * Makes a removal durable. The counter forgets on restart, so a scope given an `onRemove` calls it with the names of
 * the tools it is about to remove, and the owner of the scope expires the approvals queued for them in its own database.
 * That is what keeps an identical registration that comes back after a restart from matching an approval issued before
 * the removal. It belongs to the scope, which belongs to one registry, so another app opening or closing can't redirect
 * it. An unchanged restart removes nothing, so its approvals are untouched. It runs before the removal is published; if it
 * throws, the removal does not happen and rollback() throws.
 */
export type RemovalSink = (toolNames: string[]) => void;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function applyTool(cell: Cell, s: State, owner: string, digest: string, def: ToolDef): RegisteredTool {
  if (!def || typeof def.name !== "string" || !def.name) throw new Error("An MCP tool needs a name.");
  if (s.tools.has(def.name)) throw new Error(`Duplicate MCP tool: ${def.name}`);
  if (typeof def.handler !== "function") throw new Error(`MCP tool ${def.name} has no handler.`);
  if (!(AREAS as readonly string[]).includes(def.area)) throw new Error(`MCP tool ${def.name} has an unknown area "${def.area}".`);
  if (!(def.tier in EFFECTS_FOR_TIER)) throw new Error(`MCP tool ${def.name} has an unknown tier "${def.tier}".`);
  const effect = def.effect ?? defaultEffect(def.tier);
  if (!EFFECTS_FOR_TIER[def.tier].includes(effect)) throw new Error(`MCP tool ${def.name}: effect "${effect}" is not allowed for tier "${def.tier}".`);
  if (!def.input || typeof def.input !== "object") throw new Error(`MCP tool ${def.name} has no input schema.`);
  if (def.capability !== undefined) {
    const locker = s.lockedBy.get(def.capability);
    if (locker && locker !== CORE && locker !== owner) throw new Error(`MCP tool ${def.name}: capability "${def.capability}" belongs to another extension.`);
  }
  const fingerprint = sha(canonical({ name: def.name, owner, digest, tier: def.tier, effect, area: def.area, capability: def.capability ?? null, schema: schemaOf(def.input), removals: cell.removals.get(def.name) ?? 0 }));
  const tool = Object.freeze({ ...def, input: Object.freeze({ ...def.input }), effect, owner, fingerprint }) as RegisteredTool;
  s.tools.set(def.name, tool);
  return tool;
}

function applyLock(s: State, owner: string, id: string): void {
  const locker = s.lockedBy.get(id);
  if (locker && locker !== owner) throw new Error(`Capability "${id}" is already locked by another owner.`);
  for (const t of s.tools.values()) if (t.capability === id && t.owner !== owner) throw new Error(`Capability "${id}" already has tools from another owner, so it can't be locked.`);
  s.lockedBy.set(id, owner);
}

function applyGrant(s: State, owner: string, id: string, grant: boolean): void {
  const locker = s.lockedBy.get(id);
  if (locker && locker !== CORE && locker !== owner) throw new Error(`Capability "${id}" belongs to another extension.`);
  const holder = s.grantedBy.get(id);
  if (holder && holder !== owner) throw new Error(`Capability "${id}" was granted by another owner.`);
  if (grant) s.grantedBy.set(id, owner);
  else s.grantedBy.delete(id);
}

function purgeOwner(s: State, owner: string): string[] {
  const removed: string[] = [];
  for (const [name, t] of s.tools) {
    if (t.owner !== owner) continue;
    s.tools.delete(name);
    removed.push(name);
  }
  for (const [id, o] of s.lockedBy) if (o === owner) s.lockedBy.delete(id);
  for (const [id, o] of s.grantedBy) if (o === owner) s.grantedBy.delete(id);
  s.policies = s.policies.filter((p) => p.owner !== owner);
  return removed;
}

type Op = (s: State) => void;

export interface RegistryScope {
  readonly owner: string;
  defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S>;
  lockCapability(id: string): void;
  grantCapability(id: string): void;
  revokeCapability(id: string): void;
  registerFeaturePolicy(fn: FeaturePolicy): void;
  /** Publishes everything staged, all or nothing. After this the scope applies changes directly. */
  commit(): void;
  /** Drops everything staged, or removes everything this owner already published. The scope is closed afterwards. */
  rollback(): void;
}

function makeScope(cell: Cell, owner: string, digest: string, opts: { staged?: boolean; onRemove?: RemovalSink }): RegistryScope {
  let mode: "staging" | "live" | "closed" = opts.staged === false ? "live" : "staging";
  let draft = cell.state.clone();
  const ops: Op[] = [];
  const run = (op: Op) => {
    if (mode === "closed") throw new Error("This module is no longer registered, so it can't change tools or capabilities.");
    if (mode === "live") {
      const next = cell.state.clone();
      op(next);
      cell.state = next;
      return;
    }
    op(draft);
    ops.push(op);
  };
  const scope: RegistryScope = {
    owner,
    defineTool<S extends z.ZodRawShape>(def: ToolDef<S>) {
      run((s) => void applyTool(cell, s, owner, digest, def as unknown as ToolDef));
      return def;
    },
    lockCapability: (id) => run((s) => applyLock(s, owner, id)),
    grantCapability: (id) => run((s) => applyGrant(s, owner, id, true)),
    revokeCapability: (id) => run((s) => applyGrant(s, owner, id, false)),
    registerFeaturePolicy: (fn) => {
      if (typeof fn !== "function") throw new Error("A feature policy must be a function.");
      run((s) => void s.policies.push({ owner, fn }));
    },
    commit() {
      if (mode !== "staging") throw new Error("Nothing is staged.");
      const next = cell.state.clone();
      for (const op of ops) op(next); // throws before anything is published
      cell.state = next;
      mode = "live";
      ops.length = 0;
    },
    rollback() {
      if (mode === "live") {
        const next = cell.state.clone();
        const removed = purgeOwner(next, owner);
        // Durable first: if expiring the approvals fails, the registry is left as it was rather than removed with approvals still valid.
        if (removed.length) opts.onRemove?.(removed);
        cell.state = next;
        for (const name of removed) cell.removals.set(name, (cell.removals.get(name) ?? 0) + 1);
      }
      ops.length = 0;
      draft = new State();
      mode = "closed";
    },
  };
  return scope;
}

// Built-in definitions: made when the tool modules load, then shared. Registering one after an app has been built doesn't
// reach that app, which is the point: an app's tools are fixed when it starts.
const builtins: Cell = { state: new State(), removals: new Map(), disabled: new Set() };
const core = makeScope(builtins, CORE, "", { staged: false });

/** Feature modules call this next to their routes. A feature isn't done until its tools exist. Every app built afterwards has the tool. */
export const defineTool: RegistryScope["defineTool"] = (def) => core.defineTool(def);
/** Marks a group as available only once an extension grants it. Core calls this at startup for groups that extensions provide. */
export const lockCapability = (id: string): void => core.lockCapability(id);
/** Core-level feature policy. It applies to every tool. */
export const registerFeaturePolicy = (fn: FeaturePolicy): void => core.registerFeaturePolicy(fn);
export function grantCapability(id: string): void {
  core.grantCapability(id);
}
export function revokeCapability(id: string): void {
  core.revokeCapability(id);
}

/**
 * One app's tool registry. It starts from the shared built-ins and holds everything that changes afterwards: the tools,
 * capability locks, grants and feature policies extensions register, the capability switches, and the removal counters. It
 * is created with the app and lives on `ctx.tools`; the gate, the MCP routes, extension loading and startup approval expiry
 * all use the registry of the app they belong to.
 */
export class ToolRegistry {
  private readonly cell: Cell = { state: builtins.state.clone(), removals: new Map(), disabled: new Set() };

  /**
   * Registrations for one owner. While staging, changes go to a private copy of this registry that nothing else can see, so
   * a module whose `register()` throws leaves no tools, locks, grants or policies behind. `commit()` replays them onto the
   * live registry atomically. Capabilities and policies an owner registers can't touch another owner's.
   */
  createScope(owner: string, digest = "", opts: { staged?: boolean; onRemove?: RemovalSink } = {}): RegistryScope {
    if (owner === CORE) throw new Error(`"${CORE}" is reserved for the app's own registrations.`);
    return makeScope(this.cell, owner, digest, opts);
  }

  all = (): RegisteredTool[] => [...this.cell.state.tools.values()];
  find = (name: string): RegisteredTool | undefined => this.cell.state.tools.get(name);

  isCapabilityAvailable = (id: string): boolean => !this.cell.disabled.has(id) && (!this.cell.state.lockedBy.has(id) || this.cell.state.grantedBy.has(id));
  /** Switches a whole group of tools off (or back on). Tools without a capability are always available. */
  setCapabilityEnabled(id: string, enabled: boolean): void {
    if (enabled) this.cell.disabled.delete(id);
    else this.cell.disabled.add(id);
  }

  /** Level, area and capability: the part of "may this connection use this tool" that doesn't depend on the arguments. */
  toolAllowed = (t: RegisteredTool, caller: Pick<Caller, "level" | "areas">): boolean =>
    tierAllowed(caller.level, t.tier) && caller.areas.includes(t.area) && !(t.capability && !this.isCapabilityAvailable(t.capability));

  toolsFor(caller: Pick<Caller, "level" | "areas">): RegisteredTool[] {
    return this.all().filter((t) => this.toolAllowed(t, caller));
  }

  /** Test hook: forgets the removal counters, as a restart would. */
  resetRemovalCountersForTests(): void {
    this.cell.removals.clear();
  }

  /** Runs the feature policies that apply to this tool. Fails closed: a policy that throws, returns a promise or anything but a clear yes denies. */
  checkFeaturePolicies(tool: RegisteredTool, caller: Caller, args: Record<string, unknown>): { allow: true } | { allow: false; message: string } {
    const { state } = this.cell;
    const req: PolicyRequest = {
      tool: { name: tool.name, area: tool.area, tier: tool.tier, effect: tool.effect, capability: tool.capability, owner: tool.owner },
      caller: Object.freeze({ ...caller, areas: [...caller.areas] }),
      args: Object.freeze(structuredClone(args)),
    };
    for (const p of state.policies) {
      const applies = p.owner === CORE || tool.owner === p.owner || (!!tool.capability && state.lockedBy.get(tool.capability) === p.owner);
      if (!applies) continue;
      let allow = false;
      let message: string | undefined;
      try {
        const v = p.fn(structuredClone(req) as PolicyRequest);
        if (v === true) allow = true;
        else if (v && typeof v === "object" && (v as { allow?: unknown }).allow === true) allow = true;
        else if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") message = (v as { message: string }).message;
      } catch {
        allow = false;
      }
      if (!allow) return { allow: false, message: (message ?? "This feature is not available.").slice(0, 300) };
    }
    return { allow: true };
  }
}
