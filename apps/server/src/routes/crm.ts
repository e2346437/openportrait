import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import * as contacts from "../domain/contacts.js";
import type { ServiceContext } from "../domain/context.js";
import * as leads from "../domain/leads.js";
import * as shoots from "../domain/shoots.js";
import { SHOOT_STATUSES } from "../domain/shoots.js";
import { parse } from "../validate.js";

/** Builds the service context for a request from the signed-in staff user. */
export function serviceContext(app: FastifyInstance, req: FastifyRequest): ServiceContext {
  const { db, settings, config } = app.ctx;
  return { db, settings, config, actorId: req.user?.id ?? null, publicUrl: app.ctx.publicUrl };
}

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullish();

const ContactBody = z.object({
  firstName: text(120).optional(),
  lastName: text(120).optional(),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email address.").max(254)]).nullish(),
  phone: optText(60),
  company: optText(160),
  addressLine1: optText(200),
  addressLine2: optText(200),
  city: optText(120),
  region: optText(120),
  postalCode: optText(40),
  country: optText(80),
  source: optText(120),
});

const num = (v: unknown) => (typeof v === "string" && v !== "" ? Number(v) : v);
const ListQuery = z.object({ q: z.string().optional(), tag: z.string().optional(), archived: z.enum(["true", "false"]).optional(), limit: z.preprocess(num, z.number().int().min(1).max(200).optional()), offset: z.preprocess(num, z.number().int().min(0).optional()) });

const EventBody = z.object({
  title: text(160).optional(),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  allDay: z.boolean().optional(),
  location: optText(200),
});

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD.");

export async function crmRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const ctx = (req: FastifyRequest) => serviceContext(app, req);

  // ---- contacts ----
  app.get("/contacts", async (req, reply) => {
    const q = parse(ListQuery, req.query, reply);
    if (!q) return;
    return contacts.listContacts(ctx(req), { ...q, archived: q.archived === "true" });
  });
  app.post("/contacts", async (req, reply) => {
    const body = parse(ContactBody, req.body, reply);
    if (!body) return;
    return reply.code(201).send(contacts.createContact(ctx(req), body));
  });
  app.get("/contacts/:id", async (req) => contacts.getContact(ctx(req), (req.params as { id: string }).id));
  app.patch("/contacts/:id", async (req, reply) => {
    const body = parse(ContactBody, req.body, reply);
    if (!body) return;
    const c = ctx(req);
    contacts.updateContact(c, (req.params as { id: string }).id, body);
    return contacts.getContact(c, (req.params as { id: string }).id);
  });
  app.post("/contacts/:id/archive", async (req) => contacts.setArchived(ctx(req), (req.params as { id: string }).id, true));
  app.post("/contacts/:id/restore", async (req) => contacts.setArchived(ctx(req), (req.params as { id: string }).id, false));
  app.put("/contacts/:id/tags", async (req, reply) => {
    const body = parse(z.object({ tags: z.array(text(40)).max(30) }), req.body, reply);
    if (!body) return;
    return { tags: contacts.setContactTags(ctx(req), (req.params as { id: string }).id, body.tags) };
  });
  app.get("/tags", async (req) => ({ tags: contacts.listTags(ctx(req)) }));
  app.post("/contacts/:id/notes", async (req, reply) => {
    const body = parse(z.object({ body: z.string(), leadId: z.string().optional(), shootId: z.string().optional() }), req.body, reply);
    if (!body) return;
    return reply.code(201).send(contacts.addNote(ctx(req), (req.params as { id: string }).id, body.body, body));
  });
  app.delete("/notes/:id", async (req, reply) => {
    contacts.deleteNote(ctx(req), (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // ---- leads ----
  const LeadBody = z.object({
    contactId: z.string().optional(),
    contact: ContactBody.optional(),
    shootTypeId: z.string().nullish(),
    source: optText(120),
    message: optText(10_000),
    eventDate: z.union([z.literal(""), DateOnly]).nullish(),
    stageId: z.string().optional(),
  });
  app.get("/leads", async (req) => ({ stages: leads.board(ctx(req)) }));
  app.post("/leads", async (req, reply) => {
    const body = parse(LeadBody, req.body, reply);
    if (!body) return;
    return reply.code(201).send(leads.createLead(ctx(req), body));
  });
  app.get("/leads/:id", async (req) => leads.getLead(ctx(req), (req.params as { id: string }).id));
  app.patch("/leads/:id", async (req, reply) => {
    const body = parse(LeadBody.pick({ shootTypeId: true, source: true, message: true, eventDate: true }), req.body, reply);
    if (!body) return;
    return leads.updateLead(ctx(req), (req.params as { id: string }).id, body);
  });
  app.post("/leads/:id/move", async (req, reply) => {
    const body = parse(z.object({ stageId: z.string() }), req.body, reply);
    if (!body) return;
    return leads.moveLead(ctx(req), (req.params as { id: string }).id, body.stageId);
  });
  app.post("/leads/:id/lose", async (req, reply) => {
    const body = parse(z.object({ reason: optText(300) }), req.body ?? {}, reply);
    if (!body) return;
    return leads.loseLead(ctx(req), (req.params as { id: string }).id, body.reason ?? undefined);
  });
  app.post("/leads/:id/convert", async (req, reply) => {
    const body = parse(z.object({ shootTypeId: z.string().optional(), subject: optText(200), events: z.array(EventBody).max(10).optional() }), req.body ?? {}, reply);
    if (!body) return;
    return leads.convertLead(ctx(req), (req.params as { id: string }).id, { ...body, subject: body.subject ?? undefined });
  });

  // ---- shoots ----
  const ShootList = z.object({
    q: z.string().optional(),
    status: z.enum([...SHOOT_STATUSES, "active"]).optional(),
    when: z.enum(["upcoming", "past", "all"]).optional(),
    limit: z.preprocess(num, z.number().int().min(1).max(200).optional()),
    offset: z.preprocess(num, z.number().int().min(0).optional()),
  });
  app.get("/shoots", async (req, reply) => {
    const q = parse(ShootList, req.query, reply);
    if (!q) return;
    return shoots.listShoots(ctx(req), { ...q, ids: req.shootScope ?? undefined });
  });
  app.post("/shoots", async (req, reply) => {
    const body = parse(
      z.object({ primaryContactId: z.string(), shootTypeId: z.string(), subject: optText(200), events: z.array(EventBody).max(10).optional(), notes: optText(10_000) }),
      req.body,
      reply,
    );
    if (!body) return;
    return reply.code(201).send(shoots.createShoot(ctx(req), { ...body, subject: body.subject ?? undefined }));
  });
  app.get("/shoots/:id", async (req) => shoots.getShoot(ctx(req), (req.params as { id: string }).id));
  app.patch("/shoots/:id", async (req, reply) => {
    const body = parse(z.object({ subject: text(200).optional(), shootTypeId: z.string().optional(), status: z.enum(SHOOT_STATUSES).optional(), notes: optText(10_000), primaryContactId: z.string().optional() }), req.body, reply);
    if (!body) return;
    return shoots.updateShoot(ctx(req), (req.params as { id: string }).id, body);
  });
  app.post("/shoots/:id/events", async (req, reply) => {
    const body = parse(EventBody, req.body, reply);
    if (!body) return;
    return reply.code(201).send(shoots.addEvent(ctx(req), (req.params as { id: string }).id, body));
  });
  app.patch("/shoots/:id/events/:eventId", async (req, reply) => {
    const body = parse(EventBody.partial(), req.body, reply);
    if (!body) return;
    const p = req.params as { id: string; eventId: string };
    return shoots.updateEvent(ctx(req), p.id, p.eventId, body);
  });
  app.delete("/shoots/:id/events/:eventId", async (req) => {
    const p = req.params as { id: string; eventId: string };
    return shoots.removeEvent(ctx(req), p.id, p.eventId);
  });
  app.put("/shoots/:id/contacts/:contactId", async (req, reply) => {
    const body = parse(z.object({ role: text(60).optional() }), req.body ?? {}, reply);
    if (!body) return;
    const p = req.params as { id: string; contactId: string };
    return shoots.addShootContact(ctx(req), p.id, p.contactId, body.role);
  });
  app.delete("/shoots/:id/contacts/:contactId", async (req) => {
    const p = req.params as { id: string; contactId: string };
    return shoots.removeShootContact(ctx(req), p.id, p.contactId);
  });
  app.post("/shoots/:id/rename-folder", async (req) => shoots.renameFolder(ctx(req), (req.params as { id: string }).id));
}
