import { z } from "zod";
import { VERSION } from "../app.js";
import { defineTool, toolsFor } from "./registry.js";

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
