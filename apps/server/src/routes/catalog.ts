import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import * as catalog from "../domain/catalog.js";
import * as shoots from "../domain/shoots.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const name = z.string().trim().min(1, "Enter a name.").max(80);

/** Shoot types, lead stages and folder naming. Anyone signed in can read; only the owner changes them. */
export async function catalogRoutes(app: FastifyInstance) {
  const ctx = (req: FastifyRequest) => serviceContext(app, req);
  const p = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get("/shoot-types", { preHandler: requireUser }, async (req) => ({ types: catalog.listShootTypes(ctx(req), { includeArchived: (req.query as { archived?: string }).archived === "true" }) }));
  app.post("/shoot-types", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ name, folderLabel: z.string().trim().max(80).optional(), autoPublish: z.boolean().optional() }), req.body, reply);
    if (!body) return;
    return reply.code(201).send(catalog.createShootType(ctx(req), body));
  });
  app.patch("/shoot-types/:id", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ name: name.optional(), folderLabel: z.string().trim().max(80).optional(), autoPublish: z.boolean().optional() }), req.body, reply);
    if (!body) return;
    return catalog.updateShootType(ctx(req), p(req), body);
  });
  app.delete("/shoot-types/:id", { preHandler: requireOwner }, async (req) => ({ result: catalog.removeShootType(ctx(req), p(req)) }));
  app.put("/shoot-types-order", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ ids: z.array(z.string()) }), req.body, reply);
    if (!body) return;
    return { types: catalog.reorderShootTypes(ctx(req), body.ids) };
  });

  app.get("/lead-stages", { preHandler: requireUser }, async (req) => ({ stages: catalog.listStages(ctx(req)) }));
  app.post("/lead-stages", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ name }), req.body, reply);
    if (!body) return;
    return reply.code(201).send(catalog.createStage(ctx(req), body.name));
  });
  app.patch("/lead-stages/:id", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ name }), req.body, reply);
    if (!body) return;
    return catalog.renameStage(ctx(req), p(req), body.name);
  });
  app.delete("/lead-stages/:id", { preHandler: requireOwner }, async (req, reply) => {
    catalog.removeStage(ctx(req), p(req));
    return reply.code(204).send();
  });
  app.put("/lead-stages-order", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ ids: z.array(z.string()) }), req.body, reply);
    if (!body) return;
    return { stages: catalog.reorderStages(ctx(req), body.ids) };
  });

  const FolderBody = z.object({ pattern: z.string().trim().min(1, "Enter a folder pattern.").max(200), rawSubdir: z.string().trim().max(200), deliverySubdir: z.string().trim().max(200) });
  app.get("/folders", { preHandler: requireUser }, async (req) => {
    const s = shoots.folderSettings(ctx(req));
    return { ...s, example: shoots.previewFolder(ctx(req), s.pattern), root: app.ctx.config.galleriesDir };
  });
  app.put("/folders", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(FolderBody, req.body, reply);
    if (!body) return;
    const s = shoots.saveFolderSettings(ctx(req), body);
    return { ...s, example: shoots.previewFolder(ctx(req), s.pattern), root: app.ctx.config.galleriesDir };
  });
  /** Live preview while typing, without saving. */
  app.post("/folders/preview", { preHandler: requireUser }, async (req, reply) => {
    const body = parse(z.object({ pattern: z.string().max(200) }), req.body, reply);
    if (!body) return;
    return { example: shoots.previewFolder(ctx(req), body.pattern) };
  });
}
