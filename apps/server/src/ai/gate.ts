import { eq } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import type { AppContext } from "../app.js";
import { canonical, dispositionFor, type Disposition, tierAllowed, type Caller, type RegisteredTool } from "./registry.js";
import crypto from "node:crypto";

/**
 * The one place that decides whether a tool call may run. A live MCP call and an owner-approved call resumed later both
 * come through `authorize`, so they can't drift apart. Everything is looked up again at the moment of execution (the
 * connection, the registration, the switches, the capability) and anything that can't be confirmed refuses.
 */

export type GateCode = "denied" | "invalid" | "stale" | "unavailable";

export class GateError extends Error {
  constructor(
    message: string,
    readonly code: GateCode,
  ) {
    super(message);
    this.name = "GateError";
  }
}

export interface GateRequest {
  connectionId: string;
  tool: string;
  /** Arguments exactly as received. They are validated here; the validated copy is what runs. */
  args: unknown;
  /** Set when resuming an approval: the binding recorded when it was queued. The call is refused unless it still matches. */
  expectedBinding?: string | null;
  /** Set when queueing an approval: refuses a tool whose validated arguments would not survive being stored and validated again. */
  forApproval?: boolean;
}

export interface GateGrant {
  tool: RegisteredTool;
  caller: Caller;
  /** The arguments after validation. Run the tool with these, never with the raw input. */
  args: Record<string, unknown>;
  /** Hash of the registration identity, the connection and the validated arguments. */
  binding: string;
  /** What the tool's effect allows: run now, run after the owner's code, or wait for the owner's approval. */
  disposition: Disposition;
}

/** Ties an approval to the exact registration, connection and arguments it was granted for. */
export function bindingFor(tool: Pick<RegisteredTool, "fingerprint">, connectionId: string, args: unknown): string {
  return crypto.createHash("sha256").update(canonical({ registration: tool.fingerprint, connection: connectionId, args })).digest("hex");
}

const parseArgs = (tool: RegisteredTool, raw: unknown): Record<string, unknown> => {
  const parsed = z.object(tool.input).safeParse(raw ?? {});
  if (!parsed.success) throw new GateError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ").slice(0, 400)}`, "invalid");
  return parsed.data as Record<string, unknown>;
};

export function authorize(ctx: AppContext, req: GateRequest): GateGrant {
  try {
    // Switches: off means off, for both paths.
    if (!ctx.settings.get("ai.enabled")) throw new GateError("AI access is turned off, so the action was not run.", "denied");
    if (ctx.settings.get("ai.paused")) throw new GateError("AI access is paused by the studio owner, so the action was not run.", "denied");

    // The connection as it is now, not as it was when the request started or was queued.
    const conn = ctx.db.select().from(tables.aiConnection).where(eq(tables.aiConnection.id, req.connectionId)).get();
    // accessExpiresAt is not checked here: it only marks the short-lived OAuth access token (checked when a request authenticates), which refreshes while the connection itself stays valid.
    if (!conn || conn.revokedAt || (conn.expiresAt && conn.expiresAt.getTime() <= Date.now())) {
      throw new GateError("This connection has been revoked or has expired, so the action was not run.", "denied");
    }
    const caller: Caller = { connectionId: conn.id, label: conn.label, level: conn.level, areas: [...conn.areas] };

    // The registration as it is now.
    // From this app's own registry: another app in the same process may have different tools loaded.
    const tool = ctx.tools.find(req.tool);
    if (!tool) throw new GateError("This action isn't available any more.", "unavailable");

    // The effect decides how this call may proceed. No decision for the effect and tier means no run, whatever else would allow it.
    const disposition = dispositionFor(tool);
    if (!disposition) throw new GateError("This action's type isn't recognized, so it was not run.", "denied");
    // A resumed call exists only because the owner approved it, so only actions that wait for approval can be resumed.
    if (req.expectedBinding !== undefined && disposition !== "approve") throw new GateError("This action doesn't need approval, so the request was not run.", "denied");

    const args = parseArgs(tool, req.args);

    if (!caller.areas.includes(tool.area)) throw new GateError("This connection is not allowed to use this area, so the action was not run.", "denied");
    if (!tierAllowed(caller.level, tool.tier)) throw new GateError("This connection's access level doesn't allow this action, so it was not run.", "denied");
    if (tool.capability && !ctx.tools.isCapabilityAvailable(tool.capability)) throw new GateError("This connection is no longer allowed to do this (the feature is switched off), so the action was not run.", "unavailable");
    const policy = ctx.tools.checkFeaturePolicies(tool, caller, args);
    if (!policy.allow) throw new GateError(policy.message, "denied");

    const binding = bindingFor(tool, conn.id, args);
    if (req.expectedBinding !== undefined && binding !== req.expectedBinding) {
      throw new GateError("This request is out of date: the action, the connection or the details changed since it was queued, so it was not run.", "stale");
    }
    if (req.forApproval && bindingFor(tool, conn.id, parseArgs(tool, args)) !== binding) {
      throw new GateError("This action can't be queued for approval.", "denied");
    }
    return { tool, caller, args, binding, disposition };
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError("This action could not be verified, so it was not run.", "denied");
  }
}

/**
 * The only place a tool handler is called. It re-derives the disposition from the tool's effect and refuses a path the
 * effect doesn't allow, so enforcement doesn't depend on the caller having branched correctly:
 * - `direct` (a live call that wasn't queued) may run `run` tools, and `code` tools once the owner's code was verified.
 * - `approved` (the owner's approval, resumed) may run only `approve` tools.
 */
export async function invoke(ctx: AppContext, grant: GateGrant, via: "direct" | "approved", opts: { codeVerified?: boolean } = {}): Promise<unknown> {
  const disposition = dispositionFor(grant.tool);
  const allowed =
    disposition !== null &&
    disposition === grant.disposition &&
    (via === "approved" ? disposition === "approve" : disposition === "run" || (disposition === "code" && opts.codeVerified === true));
  if (!allowed) throw new GateError(disposition === "approve" && via === "direct" ? "This action has to be approved by the studio owner first, so it was not run." : "This action isn't allowed to run this way, so it was not run.", "denied");
  return grant.tool.handler(ctx, grant.args as never, grant.caller);
}
