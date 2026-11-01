import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import * as calendar from "../domain/calendar.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const num = z.preprocess((v) => (typeof v === "string" && v !== "" ? Number(v) : v), z.number().finite());
const Range = z.object({ from: num, to: num });
const Entry = z.object({
  kind: z.enum(["appointment", "block"]),
  title: z.string().trim().min(1, "Give it a title.").max(160),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  allDay: z.boolean().optional(),
  location: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  contactId: z.string().nullish(),
});

export async function calendarRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);

  app.get("/calendar", async (req, reply) => {
    const q = parse(Range, req.query, reply);
    if (!q) return;
    return { items: calendar.listCalendar(ctx(req), q.from, q.to) };
  });
  app.get("/calendar/free", async (req, reply) => {
    const q = parse(Range.extend({ minutes: num }), req.query, reply);
    if (!q) return;
    return { slots: calendar.findFreeTime(ctx(req), q.from, q.to, q.minutes) };
  });
  app.post("/calendar/entries", async (req, reply) => {
    const body = parse(Entry, req.body, reply);
    if (!body) return;
    return reply.code(201).send(calendar.createEntry(ctx(req), body));
  });
  app.get("/calendar/entries/:id", async (req) => calendar.getEntry(ctx(req), (req.params as { id: string }).id));
  app.patch("/calendar/entries/:id", async (req, reply) => {
    const body = parse(Entry.partial(), req.body, reply);
    if (!body) return;
    return calendar.updateEntry(ctx(req), (req.params as { id: string }).id, body);
  });
  app.delete("/calendar/entries/:id", async (req) => calendar.deleteEntry(ctx(req), (req.params as { id: string }).id));
}
