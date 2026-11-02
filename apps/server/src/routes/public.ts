import fs from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, type ServiceContext } from "../domain/context.js";
import * as inquiry from "../domain/inquiry.js";
import * as checkout from "../domain/checkout.js";
import * as contracts from "../domain/contracts.js";
import * as credits from "../domain/credits.js";
import * as orders from "../domain/orders.js";
import { verifyWebhook } from "../payments/paypal.js";
import * as sched from "../domain/scheduler.js";
import { parse } from "../validate.js";

const Inquiry = z.object({
  firstName: z.string().trim().min(1, "Please enter your name.").max(120),
  lastName: z.string().trim().max(120).optional(),
  email: z.string().trim().max(254),
  phone: z.string().trim().max(60).optional(),
  shootTypeId: z.string().max(100).optional(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as year-month-day.").optional().or(z.literal("")),
  message: z.string().trim().max(5000).optional(),
  /** A field real visitors never see. Bots fill it in. */
  website: z.string().max(500).optional(),
});
const Booking = z.object({
  startsAt: z.number().int(),
  firstName: z.string().trim().min(1, "Please enter your name.").max(120),
  lastName: z.string().trim().max(120).optional(),
  email: z.string().trim().max(254),
  phone: z.string().trim().max(60).optional(),
  message: z.string().trim().max(2000).optional(),
  couponCode: z.string().trim().max(40).optional(),
  website: z.string().max(500).optional(),
});

/** What clients and visitors can reach without signing in: the inquiry form and booking pages. */
export async function publicRoutes(app: FastifyInstance) {
  const ctx = (req: FastifyRequest): ServiceContext => ({ db: app.ctx.db, settings: app.ctx.settings, config: app.ctx.config, actorId: null, publicUrl: app.ctx.publicUrl });
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => app.ctx.ip(req) } });
  const slugOf = (req: FastifyRequest) => (req.params as { slug: string }).slug;
  // Public pages are small, personal and never worth caching in a shared cache.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  app.get("/inquiry", async (req) => inquiry.publicFormInfo(ctx(req)));
  app.post("/inquiry", { config: limit(6) }, async (req, reply) => {
    const body = parse(Inquiry, req.body, reply);
    if (!body) return;
    if (body.website) return { ok: true }; // a bot: look successful, do nothing
    return inquiry.submitInquiry(ctx(req), body);
  });

  const page = (req: FastifyRequest) => {
    const s = sched.getBySlug(ctx(req), slugOf(req));
    if (!s || !s.active) throw new DomainError("not_found", "This booking page isn't available.", 404);
    return s;
  };
  app.get("/book/:slug", async (req) => {
    const s = page(req);
    const c = ctx(req);
    return {
      name: s.name,
      description: s.description,
      durationMinutes: s.durationMinutes,
      location: s.location,
      approval: s.approval,
      studioName: c.settings.get("studio.name") ?? "",
      timezone: c.settings.get("studio.timezone") ?? "UTC",
      maxDaysAhead: s.maxDaysAhead,
      price: sched.priceFor(c, s),
      deposit: s.priceCents > 0 && s.depositType !== "none" ? { type: s.depositType, value: s.depositValue } : null,
    };
  });
  // Lets a visitor check a coupon and see the new price and deposit before they book.
  app.post("/book/:slug/price", { config: limit(20) }, async (req, reply) => {
    const body = parse(z.object({ couponCode: z.string().trim().max(40).optional() }), req.body ?? {}, reply);
    if (!body) return;
    return { price: sched.priceFor(ctx(req), page(req), body.couponCode) };
  });
  app.get("/book/:slug/slots", { config: limit(60) }, async (req, reply) => {
    const q = parse(z.object({ from: z.string(), to: z.string() }), req.query, reply);
    if (!q) return;
    return { days: sched.availableSlots(ctx(req), page(req), q.from, q.to) };
  });
  app.post("/book/:slug", { config: limit(8) }, async (req, reply) => {
    const body = parse(Booking, req.body, reply);
    if (!body) return;
    if (body.website) return { id: "x", status: "pending", startsAt: body.startsAt, endsAt: body.startsAt, cancelToken: "", when: "" };
    return reply.code(201).send(sched.createBooking(ctx(req), slugOf(req), body));
  });

  const token = (req: FastifyRequest) => (req.params as { token: string }).token;
  app.get("/book-cancel/:token", { config: limit(30) }, async (req) => sched.bookingByToken(ctx(req), token(req)));
  app.post("/book-cancel/:token", { config: limit(10) }, async (req) => sched.cancelByToken(ctx(req), token(req)));

  // Quotes and invoices: the private link is the key, so these are rate limited and never cached.
  const orderToken = token;
  /** The client's page: the document plus what they can do about paying it. */
  const orderPage = (req: FastifyRequest, view?: ReturnType<typeof orders.publicView>) => {
    const c = ctx(req);
    const v = view ?? orders.publicView(c, orderToken(req));
    const o = orders.byToken(c, orderToken(req));
    const available = credits.creditAvailable(c, o.id);
    return { ...v, pay: checkout.onlineOptions(c, orderToken(req)), credit: available > 0 ? { availableCents: available } : null };
  };
  app.get("/order/:token", { config: limit(60) }, async (req) => orderPage(req));
  app.post("/order/:token/credit", { config: limit(10) }, async (req) => {
    const o = orders.byToken(ctx(req), orderToken(req));
    credits.applyCredit(ctx(req), o.id);
    return orderPage(req);
  });
  app.post("/order/:token/coupon", { config: limit(10) }, async (req, reply) => {
    const body = parse(z.object({ code: z.string().trim().max(40) }), req.body, reply);
    if (!body) return;
    orders.applyQuoteCoupon(ctx(req), orderToken(req), body.code);
    return orderPage(req);
  });
  app.post("/order/:token/pay", { config: limit(10) }, async (req, reply) => {
    const body = parse(z.object({ amount: z.enum(["due", "balance"]) }), req.body, reply);
    if (!body) return;
    return checkout.startCheckout(ctx(req), orderToken(req), body);
  });
  app.post("/order/:token/pay/capture", { config: limit(20) }, async (req, reply) => {
    const body = parse(z.object({ providerOrderId: z.string().min(1).max(100) }), req.body, reply);
    if (!body) return;
    const { outcome, view } = await checkout.finishCheckout(ctx(req), orderToken(req), body.providerOrderId);
    return { outcome, ...orderPage(req, view) };
  });
  app.post("/order/:token/accept", { config: limit(10) }, async (req, reply) => {
    const body = parse(z.object({ name: z.string().max(120) }), req.body, reply);
    if (!body) return;
    return orders.acceptQuote(ctx(req), orderToken(req), { name: body.name, ip: app.ctx.ip(req) });
  });
  app.post("/order/:token/decline", { config: limit(10) }, async (req, reply) => {
    const body = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {}, reply);
    if (!body) return;
    return orders.declineQuote(ctx(req), orderToken(req), body.reason);
  });

  // Contracts: the private link is the key. Signing records where it came from.
  app.get("/contract/:token", { config: limit(60) }, async (req) => contracts.publicView(ctx(req), orderToken(req)));
  app.post("/contract/:token/sign", { config: limit(10), bodyLimit: 300_000 }, async (req, reply) => {
    const body = parse(z.object({ name: z.string().max(120), consent: z.boolean(), method: z.enum(["typed", "drawn"]), image: z.string().max(250_000).nullish() }), req.body, reply);
    if (!body) return;
    return contracts.signContract(ctx(req), orderToken(req), { ...body, ip: app.ctx.ip(req), userAgent: String(req.headers["user-agent"] ?? "") });
  });
  app.get("/contract/:token/pdf", { config: limit(20) }, async (req, reply) => {
    const { file, name } = contracts.pdfByToken(ctx(req), orderToken(req));
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `attachment; filename="${name}"`).send(fs.createReadStream(file));
  });

  // PayPal calls this. The signature is checked against the body exactly as it arrived, so this scope keeps the raw text.
  await app.register(async (hookApp) => {
    hookApp.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 262_144 }, (_req, body, done) => done(null, body));
    hookApp.post("/paypal/webhook", { config: limit(120) }, async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const h = req.headers;
      const one = (k: string) => (typeof h[k] === "string" ? (h[k] as string) : undefined);
      const c = ctx(req);
      const ok = await verifyWebhook(c, { authAlgo: one("paypal-auth-algo"), certUrl: one("paypal-cert-url"), transmissionId: one("paypal-transmission-id"), transmissionSig: one("paypal-transmission-sig"), transmissionTime: one("paypal-transmission-time") }, raw);
      if (!ok) return reply.code(401).send({ error: "unverified" });
      let event: { event_type?: string; resource?: Record<string, unknown> };
      try {
        event = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "bad body" });
      }
      try {
        await checkout.handleWebhookEvent(c, event);
      } catch (err) {
        app.log.warn({ err }, "paypal webhook handling failed");
        return reply.code(500).send({ error: "retry" }); // PayPal retries on non-2xx
      }
      return { ok: true };
    });
  });
}
