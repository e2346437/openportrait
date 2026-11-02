import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import * as households from "../domain/households.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

/** Households: people who share a home or a company, so their details and history sit together. */
export async function householdRoutes(app: FastifyInstance) {
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  app.addHook("preHandler", requireUser);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/households/:id", async (req) => households.getHousehold(ctx(req), id(req)));
  app.patch("/households/:id", async (req, reply) => {
    const b = parse(z.object({ name: z.string().max(120) }), req.body, reply);
    if (!b) return;
    return households.renameHousehold(ctx(req), id(req), b.name);
  });
  app.put("/contacts/:id/household", async (req, reply) => {
    const b = parse(z.object({ withContactId: z.string().min(1) }), req.body, reply);
    if (!b) return;
    return households.joinHouseholdOf(ctx(req), id(req), b.withContactId);
  });
  app.delete("/contacts/:id/household", async (req) => households.leaveHousehold(ctx(req), id(req)));
}
