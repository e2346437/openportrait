import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import * as tasks from "../domain/tasks.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const Due = z.string().max(10).nullish();

/** To-dos on shoots, the list across shoots, and the starter checklist for each shoot type. */
export async function taskRoutes(app: FastifyInstance) {
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  app.addHook("preHandler", requireUser);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/tasks", async (req) => {
    const q = req.query as { status?: string; dueBy?: string; shootId?: string };
    return { items: tasks.listTasks(ctx(req), { status: q.status === "done" ? "done" : "open", dueBy: q.dueBy || undefined, shootId: q.shootId || undefined }) };
  });
  app.get("/shoots/:id/tasks", async (req) => ({ items: tasks.listForShoot(ctx(req), id(req)) }));
  app.post("/shoots/:id/tasks", async (req, reply) => {
    const b = parse(z.object({ title: z.string().max(200), dueDate: Due }), req.body, reply);
    if (!b) return;
    return reply.code(201).send(tasks.addTask(ctx(req), id(req), b));
  });
  app.patch("/tasks/:id", async (req, reply) => {
    const b = parse(z.object({ title: z.string().max(200).optional(), dueDate: Due, done: z.boolean().optional() }), req.body, reply);
    if (!b) return;
    return tasks.updateTask(ctx(req), id(req), b);
  });
  app.delete("/tasks/:id", async (req) => tasks.deleteTask(ctx(req), id(req)));

  app.get("/shoot-types/:id/tasks", async (req) => ({ items: tasks.listTypeTasks(ctx(req), id(req)) }));
  app.put("/shoot-types/:id/tasks", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(z.object({ items: z.array(z.object({ title: z.string().max(200), dueDays: z.number().int().nullish() })).max(40) }), req.body, reply);
    if (!b) return;
    return { items: tasks.setTypeTasks(ctx(req), id(req), b.items) };
  });
}
