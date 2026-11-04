import crypto from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@openportrait/db";
import type { AppContext } from "../app.js";
import { findTool, toolsFor, type Caller, type ToolDef } from "./registry.js";

const EXPIRES_DAYS = 7;
/** Most outward actions one connection may queue per day, so a runaway assistant can't flood the inbox. */
export const DAILY_OUTWARD_CAP = 25;

export interface ApprovalView {
  id: string;
  connection: string;
  tool: string;
  tier: "outward" | "money";
  summary: string;
  args: unknown;
  status: "pending" | "approved" | "declined" | "expired" | "failed";
  result: unknown;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number;
}

const view = (r: typeof tables.aiApproval.$inferSelect, connection: string): ApprovalView => ({
  id: r.id,
  connection,
  tool: r.tool,
  tier: r.tier,
  summary: r.summary,
  args: r.args,
  status: r.status,
  result: r.result,
  createdAt: r.createdAt.getTime(),
  decidedAt: r.decidedAt?.getTime() ?? null,
  expiresAt: r.expiresAt.getTime(),
});

export function expireOld(ctx: AppContext): void {
  ctx.db.update(tables.aiApproval).set({ status: "expired", decidedAt: new Date() }).where(and(eq(tables.aiApproval.status, "pending"), lt(tables.aiApproval.expiresAt, new Date()))).run();
}

/** Queues a tool call for the owner. Returns what the assistant is told. */
export function queueApproval(ctx: AppContext, caller: Caller, tool: ToolDef, args: unknown) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(tables.aiApproval)
    .where(and(eq(tables.aiApproval.connectionId, caller.connectionId), gte(tables.aiApproval.createdAt, startOfDay)))
    .get()?.n ?? 0;
  if (today >= DAILY_OUTWARD_CAP) throw new Error(`Daily limit reached: ${DAILY_OUTWARD_CAP} requests for approval per day. Try again tomorrow.`);
  const summary = (tool.summarize ? tool.summarize(args as never) : tool.title).slice(0, 500);
  const id = crypto.randomUUID();
  ctx.db
    .insert(tables.aiApproval)
    .values({ id, connectionId: caller.connectionId, tool: tool.name, tier: tool.tier as "outward" | "money", summary, args, expiresAt: new Date(Date.now() + EXPIRES_DAYS * 86_400_000) })
    .run();
  return { status: "pending_approval", approvalId: id, summary, message: "The studio owner has to approve this first. Check back with approvals_get; do not repeat the request." };
}

export function listApprovals(ctx: AppContext, status?: ApprovalView["status"]): ApprovalView[] {
  expireOld(ctx);
  const rows = ctx.db
    .select({ a: tables.aiApproval, label: tables.aiConnection.label })
    .from(tables.aiApproval)
    .innerJoin(tables.aiConnection, eq(tables.aiConnection.id, tables.aiApproval.connectionId))
    .where(status ? eq(tables.aiApproval.status, status) : undefined)
    .orderBy(desc(tables.aiApproval.createdAt))
    .limit(100)
    .all();
  return rows.map((r) => view(r.a, r.label));
}

export function pendingCount(ctx: AppContext): number {
  expireOld(ctx);
  return ctx.db.select({ n: sql<number>`count(*)` }).from(tables.aiApproval).where(eq(tables.aiApproval.status, "pending")).get()?.n ?? 0;
}

/** What an assistant may see about its own request. */
export function approvalFor(ctx: AppContext, caller: Caller, id: string) {
  expireOld(ctx);
  const r = ctx.db.select().from(tables.aiApproval).where(and(eq(tables.aiApproval.id, id), eq(tables.aiApproval.connectionId, caller.connectionId))).get();
  if (!r) throw new Error("No such approval request.");
  return { id: r.id, status: r.status, summary: r.summary, result: r.status === "approved" ? r.result : undefined };
}

/** The owner's decision. Approving runs the tool as the connection that asked, then records the result. */
export async function decide(ctx: AppContext, id: string, userId: string, approve: boolean): Promise<ApprovalView> {
  expireOld(ctx);
  const r = ctx.db.select().from(tables.aiApproval).where(eq(tables.aiApproval.id, id)).get();
  const conn = r ? ctx.db.select().from(tables.aiConnection).where(eq(tables.aiConnection.id, r.connectionId)).get() : undefined;
  if (!r || !conn) throw Object.assign(new Error("That request no longer exists."), { statusCode: 404 });
  if (r.status !== "pending") throw Object.assign(new Error(`That request was already ${r.status}.`), { statusCode: 409 });
  // Claim it first, so a double click can't run the action twice.
  const claimed = ctx.db
    .update(tables.aiApproval)
    .set({ status: approve ? "approved" : "declined", decidedAt: new Date(), decidedBy: userId })
    .where(and(eq(tables.aiApproval.id, id), eq(tables.aiApproval.status, "pending")))
    .run().changes;
  if (!claimed) throw Object.assign(new Error("That request was already decided."), { statusCode: 409 });

  let result: unknown = null;
  let status: ApprovalView["status"] = approve ? "approved" : "declined";
  if (approve) {
    const tool = findTool(r.tool);
    try {
      // Re-check the connection as it is now. accessExpiresAt is not checked: it only marks the short-lived OAuth access token, which refreshes while the connection itself stays valid.
      const now = Date.now();
      if (conn.revokedAt || (conn.expiresAt && conn.expiresAt.getTime() <= now)) {
        throw new Error("This connection has been revoked or has expired, so the action was not run.");
      }
      if (!tool) throw new Error("This action isn't available any more.");
      if (!toolsFor({ level: conn.level, areas: conn.areas }).some((t) => t.name === tool.name)) {
        throw new Error("This connection is no longer allowed to do this, so the action was not run.");
      }
      const args = z.object(tool.input).parse(r.args);
      result = await tool.handler(ctx, args as never, { connectionId: conn.id, label: conn.label, level: conn.level, areas: conn.areas });
    } catch (err) {
      status = "failed";
      result = { error: err instanceof Error ? err.message : "The action failed." };
    }
    ctx.db.update(tables.aiApproval).set({ status, result }).where(eq(tables.aiApproval.id, id)).run();
  }
  ctx.db.insert(tables.auditLog).values({ userId, actorType: "user", connectionId: conn.id, action: `ai.approval.${status}`, detail: { tool: r.tool, summary: r.summary }, ip: null }).run();
  return view({ ...r, status, result, decidedAt: new Date() }, conn.label);
}
