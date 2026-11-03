import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import * as runsheet from "../domain/runsheet.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const Item = z.object({
  startMinutes: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().min(1).max(1440).nullish(),
  title: z.string().max(160),
  location: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

/** The day-of timeline for a shoot: what happens when, in studio time. */
export async function runSheetRoutes(app: FastifyInstance) {
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  app.addHook("preHandler", requireUser);
  const p = (req: { params: unknown }) => req.params as { id: string; itemId: string };

  app.get("/shoots/:id/run-sheet", async (req) => ({ items: runsheet.listRunSheet(ctx(req), p(req).id) }));
  app.post("/shoots/:id/run-sheet", async (req, reply) => {
    const b = parse(Item, req.body, reply);
    if (!b) return;
    return reply.code(201).send(runsheet.addRunItem(ctx(req), p(req).id, b as runsheet.RunItemInput));
  });
  app.patch("/shoots/:id/run-sheet/:itemId", async (req, reply) => {
    const b = parse(Item.partial(), req.body, reply);
    if (!b) return;
    return runsheet.updateRunItem(ctx(req), p(req).id, p(req).itemId, b);
  });
  app.delete("/shoots/:id/run-sheet/:itemId", async (req) => runsheet.removeRunItem(ctx(req), p(req).id, p(req).itemId));
}
