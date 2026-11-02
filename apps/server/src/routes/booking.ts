import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import * as email from "../domain/email.js";
import * as inquiry from "../domain/inquiry.js";
import * as sched from "../domain/scheduler.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const Window = z.object({ start: z.string(), end: z.string() });
const SchedulerBody = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(120),
  slug: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).nullish(),
  durationMinutes: z.number().int(),
  bufferBeforeMinutes: z.number().int().optional(),
  bufferAfterMinutes: z.number().int().optional(),
  minNoticeHours: z.number().int().optional(),
  maxDaysAhead: z.number().int().optional(),
  stepMinutes: z.number().int().optional(),
  location: z.string().trim().max(200).nullish(),
  shootTypeId: z.string().nullish(),
  approval: z.enum(["manual", "auto"]).optional(),
  priceCents: z.number().int().optional(),
  depositType: z.enum(["none", "percent", "fixed"]).optional(),
  depositValue: z.number().int().optional(),
  contractTemplateId: z.string().nullish(),
  availability: z.record(z.string(), z.array(Window).max(6)),
  active: z.boolean().optional(),
});
const EmailBody = z.object({
  host: z.string().trim().max(200),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["none", "starttls", "tls"]),
  user: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  fromName: z.string().trim().max(120).optional(),
  fromAddress: z.string().trim().max(254),
  replyTo: z.string().trim().max(254).optional(),
});

/** Staff side of email, inquiry form, schedulers and booking requests. */
export async function bookingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ---- email ----
  app.get("/email", { preHandler: requireOwner }, async (req) => ({ ...email.emailSettingsView(app.ctx.settings), recent: email.recentEmails(ctx(req), 20) }));
  app.put("/email", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(EmailBody, req.body, reply);
    if (!body) return;
    email.saveEmailSettings(ctx(req), body);
    return email.emailSettingsView(app.ctx.settings);
  });
  app.post("/email/test", { preHandler: requireOwner, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const to = req.user?.email;
    if (!to) return reply.code(400).send({ error: "invalid", message: "No address to send to." });
    const res = await email.sendTestEmail(ctx(req), to);
    return res.ok ? { ok: true, to } : reply.code(502).send({ error: "email_failed", message: res.message });
  });

  // ---- inquiry form ----
  app.get("/inquiry", async (req) => inquiry.inquirySettings(ctx(req)));
  app.put("/inquiry", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(z.object({ enabled: z.boolean().optional(), intro: z.string().max(1000).optional(), thanks: z.string().max(1000).optional(), notify: z.boolean().optional() }), req.body, reply);
    if (!body) return;
    return inquiry.saveInquirySettings(ctx(req), body);
  });

  // ---- schedulers ----
  app.get("/schedulers", async (req) => ({ items: sched.listSchedulers(ctx(req)) }));
  app.post("/schedulers", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(SchedulerBody, req.body, reply);
    if (!body) return;
    return reply.code(201).send(sched.createScheduler(ctx(req), body));
  });
  app.get("/schedulers/:id", async (req) => sched.getScheduler(ctx(req), id(req)));
  app.patch("/schedulers/:id", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(SchedulerBody, req.body, reply);
    if (!body) return;
    return sched.updateScheduler(ctx(req), id(req), body);
  });
  app.delete("/schedulers/:id", { preHandler: requireOwner }, async (req) => sched.deleteScheduler(ctx(req), id(req)));

  // ---- booking requests ----
  app.get("/bookings", async (req, reply) => {
    const q = parse(z.object({ status: z.enum(["pending", "confirmed", "declined", "cancelled"]).optional(), upcoming: z.enum(["true", "false"]).optional() }), req.query, reply);
    if (!q) return;
    return { items: sched.listBookings(ctx(req), { status: q.status, upcomingOnly: q.upcoming === "true" }) };
  });
  app.post("/bookings/:id/confirm", async (req) => sched.confirmBooking(ctx(req), id(req)));
  app.post("/bookings/:id/decline", async (req, reply) => {
    const body = parse(z.object({ reason: z.string().max(1000).optional() }), req.body ?? {}, reply);
    if (!body) return;
    return sched.declineBooking(ctx(req), id(req), body.reason);
  });
  app.post("/bookings/:id/cancel", async (req, reply) => {
    const body = parse(z.object({ reason: z.string().max(1000).optional() }), req.body ?? {}, reply);
    if (!body) return;
    return sched.cancelBooking(ctx(req), id(req), body.reason);
  });
}
