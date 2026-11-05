import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth.js";
import { homeSummary } from "../domain/home.js";
import { mediaUrl } from "../galleries/present.js";
import { serviceContext } from "./crm.js";

/** The studio home page: pulse numbers, the next seven days, what needs the owner, and the hero photo, in one call. */
export async function homeRoutes(app: FastifyInstance) {
  app.get("/home", { preHandler: requireOwner }, async (req) => homeSummary(serviceContext(app, req), app.ctx, (p) => mediaUrl(app.ctx.secrets, p, "preview")));
}
