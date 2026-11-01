import { z } from "zod";
import { VERSION } from "../../app.js";
import { modeOf } from "../../automation/registry.js";
import { recordCheckin, workQueue } from "../../automation/queue.js";
import { listShootTypes, listStages } from "../../domain/catalog.js";
import { approvalFor } from "../approvals.js";
import { defineTool, toolsFor } from "../registry.js";
import { svc } from "./util.js";

defineTool({
  name: "studio_get_summary",
  title: "Studio summary",
  description: "Basic facts about the studio: name, time zone, public address and app version. Start here to orient yourself.",
  area: "studio",
  tier: "read",
  input: {},
  handler: (ctx) => ({
    studio: ctx.settings.get("studio.name") ?? "",
    timezone: ctx.settings.get("studio.timezone") ?? "UTC",
    publicUrl: ctx.publicUrl() || null,
    version: VERSION,
    now: new Date().toISOString(),
  }),
});

defineTool({
  name: "studio_whoami",
  title: "My access",
  description: "Shows this connection's name, access level, allowed areas and the tools it can call.",
  area: "studio",
  tier: "read",
  input: { verbose: z.boolean().optional().describe("Include each tool's description.") },
  handler: (_ctx, args, caller) => ({
    connection: caller.label,
    level: caller.level,
    areas: caller.areas,
    tools: toolsFor(caller).map((t) => ({ name: t.name, area: t.area, tier: t.tier, ...(args.verbose ? { description: t.description } : {}) })),
  }),
});

defineTool({
  name: "approvals_get",
  title: "Check an approval request",
  description: "Shows whether the studio owner has approved or declined something you asked for. Use the approvalId you were given. Don't repeat the original request while it is pending.",
  area: "studio",
  tier: "read",
  input: { approvalId: z.string().describe("The approvalId returned when the action was queued.") },
  handler: (ctx, args, caller) => approvalFor(ctx, caller, args.approvalId),
});

defineTool({
  name: "studio_get_catalog",
  title: "Shoot types and lead stages",
  description: "Lists the shoot types and pipeline stages with their ids. You need these ids to create leads and shoots or to move a lead.",
  area: "studio",
  tier: "read",
  input: {},
  handler: (ctx) => {
    const s = svc(ctx);
    return {
      shootTypes: listShootTypes(s).map((t) => ({ id: t.id, name: t.name })),
      leadStages: listStages(s).map((st) => ({ id: st.id, name: st.name, kind: st.kind })),
    };
  },
});

defineTool({
  name: "studio_get_work_queue",
  title: "Work queue",
  description:
    "Things that need a decision right now, for the automations the studio owner has handed to you. Call this on a schedule (for example every morning), then handle each item with your other tools. Anything that reaches a client waits for the owner's approval. Calling this tells the studio you are on duty.",
  area: "studio",
  tier: "read",
  input: {},
  handler: (ctx) => {
    recordCheckin(ctx);
    const items = workQueue(ctx);
    return { mode: modeOf(ctx.settings), count: items.length, items: items.map((i) => ({ ...i, since: new Date(i.since).toISOString() })) };
  },
});
