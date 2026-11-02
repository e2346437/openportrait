import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import * as contracts from "../domain/contracts.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const TemplateBody = z.object({ name: z.string().max(120), body: z.string().max(60_000) });
const ContractBody = z.object({
  contactId: z.string().min(1, "Choose a client."),
  templateId: z.string().nullish(),
  title: z.string().max(200).optional(),
  body: z.string().max(60_000).optional(),
  shootId: z.string().nullish(),
  orderId: z.string().nullish(),
});

/** Staff side of contracts: templates, drafting, sending, countersigning and the signed copy. */
export async function contractRoutes(app: FastifyInstance) {
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  app.addHook("preHandler", requireUser);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/contract-fields", async () => ({ fields: contracts.MERGE_FIELDS }));
  app.get("/contract-templates", async (req) => ({ items: contracts.listTemplates(ctx(req), (req.query as { archived?: string }).archived === "true") }));
  app.post("/contract-templates", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(TemplateBody, req.body, reply);
    if (!b) return;
    return reply.code(201).send(contracts.createTemplate(ctx(req), b));
  });
  app.put("/contract-templates/:id", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(TemplateBody, req.body, reply);
    if (!b) return;
    return contracts.updateTemplate(ctx(req), id(req), b);
  });
  app.post("/contract-templates/:id/archive", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {}, reply);
    if (!b) return;
    return contracts.archiveTemplate(ctx(req), id(req), b.archived);
  });

  app.get("/contracts", async (req, reply) => {
    const q = parse(z.object({ contactId: z.string().optional(), shootId: z.string().optional(), status: z.string().optional(), q: z.string().max(100).optional() }), req.query, reply);
    if (!q) return;
    return { items: contracts.listContracts(ctx(req), q) };
  });
  app.post("/contracts", async (req, reply) => {
    const b = parse(ContractBody, req.body, reply);
    if (!b) return;
    return reply.code(201).send(contracts.createContract(ctx(req), b));
  });
  app.get("/contracts/:id", async (req) => contracts.getContract(ctx(req), id(req)));
  app.put("/contracts/:id", async (req, reply) => {
    const b = parse(z.object({ title: z.string().max(200), body: z.string().max(60_000) }), req.body, reply);
    if (!b) return;
    return contracts.updateDraft(ctx(req), id(req), b);
  });
  app.delete("/contracts/:id", async (req) => contracts.deleteDraft(ctx(req), id(req)));
  app.post("/contracts/:id/send", async (req) => contracts.sendContract(ctx(req), id(req)));
  app.post("/contracts/:id/void", async (req) => contracts.voidContract(ctx(req), id(req)));
  app.post("/contracts/:id/countersign", { preHandler: requireOwner }, async (req) => contracts.countersign(ctx(req), id(req)));
  app.get("/contracts/:id/pdf", async (req, reply) => {
    const { file, name } = contracts.pdfById(ctx(req), id(req));
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `attachment; filename="${name}"`).send(fs.createReadStream(file));
  });
}
