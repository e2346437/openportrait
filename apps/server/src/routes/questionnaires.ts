import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import * as qn from "../domain/questionnaires.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const Field = z.object({
  id: z.string().max(60).optional(),
  type: z.enum(qn.FIELD_TYPES),
  label: z.string().max(300),
  help: z.string().max(500).nullish().transform((v) => v ?? undefined),
  required: z.boolean().optional(),
  options: z.array(z.string().max(120)).max(60).optional(),
});
const TemplateBody = z.object({ name: z.string().max(120), intro: z.string().max(2000).nullish(), fields: z.array(Field).max(120) });

/** Staff side of questionnaires: the form builder, shoot type defaults, and the forms on each shoot. */
export async function questionnaireRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/questionnaire-templates", async (req) => ({ items: qn.listTemplates(ctx(req)), defaults: qn.listDefaults(ctx(req)), starters: qn.STARTERS }));
  app.post("/questionnaire-templates", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(TemplateBody, req.body, reply);
    if (!b) return;
    return reply.code(201).send(qn.createTemplate(ctx(req), b));
  });
  app.put("/questionnaire-templates/:id", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(TemplateBody, req.body, reply);
    if (!b) return;
    return qn.updateTemplate(ctx(req), id(req), b);
  });
  app.delete("/questionnaire-templates/:id", { preHandler: requireOwner }, async (req) => qn.deleteTemplate(ctx(req), id(req)));

  app.put("/shoot-types/:id/questionnaire", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(z.object({ templateId: z.string().nullable(), sendMode: z.enum(["manual", "on_booking"]).optional() }), req.body, reply);
    if (!b) return;
    return { default: qn.setDefault(ctx(req), id(req), b) };
  });

  app.get("/shoots/:id/questionnaires", async (req) => ({ items: qn.listForShoot(ctx(req), id(req)) }));
  app.post("/shoots/:id/questionnaires", async (req, reply) => {
    const b = parse(z.object({ templateId: z.string().min(1, "Choose a questionnaire."), send: z.boolean().optional() }), req.body, reply);
    if (!b) return;
    return reply.code(201).send(qn.createForShoot(ctx(req), id(req), b.templateId, { send: b.send }));
  });
  app.get("/questionnaires/:id", async (req) => qn.getQuestionnaire(ctx(req), id(req)));
  app.post("/questionnaires/:id/send", async (req) => qn.send(ctx(req), id(req)));
  app.post("/questionnaires/:id/reopen", async (req) => qn.reopen(ctx(req), id(req)));
  app.delete("/questionnaires/:id", async (req) => qn.deleteQuestionnaire(ctx(req), id(req)));
}
