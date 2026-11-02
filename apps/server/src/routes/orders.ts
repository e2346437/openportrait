import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import * as orders from "../domain/orders.js";
import * as products from "../domain/products.js";
import { testPayPal } from "../payments/paypal.js";
import { DomainError } from "../domain/context.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const Line = z.object({
  itemId: z.string().nullish(),
  description: z.string().max(300),
  detail: z.string().max(1000).nullish(),
  quantity: z.number().optional(),
  unitCents: z.number(),
  taxable: z.boolean().optional(),
});
const OrderBody = z.object({
  contactId: z.string().min(1, "Choose a client."),
  shootId: z.string().nullish(),
  leadId: z.string().nullish(),
  title: z.string().max(200),
  intro: z.string().max(3000).nullish(),
  terms: z.string().max(6000).nullish(),
  discountCents: z.number().optional(),
  validUntil: z.string().max(10).nullish(),
  lines: z.array(Line).max(100),
  schedule: z.array(z.object({ label: z.string().max(100), amountCents: z.number(), dueDate: z.string().max(10).nullish() })).max(24).optional(),
});
const Method = z.enum(orders.METHODS);
const ItemBody = z.object({ kind: z.enum(["package", "item"]).optional(), name: z.string().max(200), description: z.string().max(1000).nullish(), priceCents: z.number(), taxable: z.boolean().optional() });
const MoneySettings = z.object({
  currency: z.string().trim().length(3, "Use a three-letter currency code such as USD.").toUpperCase(),
  taxBps: z.number().int().min(0).max(5000),
  terms: z.string().max(6000),
  paymentInstructions: z.string().max(1000),
  quoteValidDays: z.number().int().min(1).max(365),
});

/** Staff side of the catalog, quotes, invoices and payments. */
export async function orderRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const ctx = (req: Parameters<typeof serviceContext>[1]) => serviceContext(app, req);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ---- online payments (PayPal) ----
  const paypalView = () => {
    const s = app.ctx.settings;
    const publicUrl = (app.ctx.publicUrl?.() ?? "").replace(/\/+$/, "");
    return {
      clientId: s.get("paypal.clientId") ?? "",
      hasSecret: !!s.get("paypal.clientSecret"),
      mode: s.get("paypal.mode") === "live" ? "live" : "sandbox",
      webhookId: s.get("paypal.webhookId") ?? "",
      webhookUrl: publicUrl.startsWith("http") ? `${publicUrl}/api/public/paypal/webhook` : "",
      hasPublicUrl: publicUrl.startsWith("http"),
      configured: !!(s.get("paypal.clientId") && s.get("paypal.clientSecret")),
    };
  };
  app.get("/payments/paypal", { preHandler: requireOwner }, async () => paypalView());
  app.put("/payments/paypal", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(z.object({ clientId: z.string().trim().max(200), clientSecret: z.string().trim().max(400).optional(), mode: z.enum(["sandbox", "live"]), webhookId: z.string().trim().max(100) }), req.body, reply);
    if (!b) return;
    const s = app.ctx.settings;
    s.set("paypal.clientId", b.clientId);
    if (b.clientSecret) s.set("paypal.clientSecret", b.clientSecret); // blank keeps the saved secret
    s.set("paypal.mode", b.mode);
    s.set("paypal.webhookId", b.webhookId);
    return paypalView();
  });
  app.post("/payments/paypal/test", { preHandler: requireOwner }, async () => {
    try {
      await testPayPal({ settings: app.ctx.settings });
      return { ok: true };
    } catch (err) {
      throw new DomainError("payment_failed", err instanceof Error ? err.message : "PayPal didn't accept those details.", 400);
    }
  });

  // ---- settings ----
  const view = () => ({
    currency: app.ctx.settings.get("money.currency") ?? "USD",
    taxBps: app.ctx.settings.get("money.taxBps") ?? 0,
    terms: app.ctx.settings.get("money.terms") ?? "",
    paymentInstructions: app.ctx.settings.get("money.paymentInstructions") ?? "",
    quoteValidDays: app.ctx.settings.get("money.quoteValidDays") ?? 30,
  });
  app.get("/money/settings", async () => view());
  app.put("/money/settings", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(MoneySettings, req.body, reply);
    if (!b) return;
    const s = app.ctx.settings;
    s.set("money.currency", b.currency);
    s.set("money.taxBps", b.taxBps);
    s.set("money.terms", b.terms);
    s.set("money.paymentInstructions", b.paymentInstructions);
    s.set("money.quoteValidDays", b.quoteValidDays);
    return view();
  });

  // ---- catalog ----
  app.get("/catalog", async (req) => ({ items: products.listItems(ctx(req), { includeArchived: (req.query as { archived?: string }).archived === "true" }) }));
  app.post("/catalog", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(ItemBody, req.body, reply);
    if (!b) return;
    return reply.code(201).send(products.createItem(ctx(req), b));
  });
  app.patch("/catalog/:id", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(ItemBody, req.body, reply);
    if (!b) return;
    return products.updateItem(ctx(req), id(req), b);
  });
  app.post("/catalog/:id/archive", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {}, reply);
    if (!b) return;
    return products.archiveItem(ctx(req), id(req), b.archived);
  });

  // ---- quotes and invoices ----
  app.get("/orders", async (req, reply) => {
    const q = parse(z.object({ kind: z.enum(["quote", "invoice"]).optional(), contactId: z.string().optional(), shootId: z.string().optional(), q: z.string().max(100).optional() }), req.query, reply);
    if (!q) return;
    return { items: orders.listOrders(ctx(req), q) };
  });
  app.post("/orders", async (req, reply) => {
    const b = parse(OrderBody.extend({ kind: z.enum(["quote", "invoice"]) }), req.body, reply);
    if (!b) return;
    const { kind, ...input } = b;
    return reply.code(201).send(orders.createOrder(ctx(req), kind, input));
  });
  app.get("/orders/:id", async (req) => orders.getOrder(ctx(req), id(req)));
  app.put("/orders/:id", async (req, reply) => {
    const b = parse(OrderBody, req.body, reply);
    if (!b) return;
    return orders.updateOrder(ctx(req), id(req), b);
  });
  app.delete("/orders/:id", async (req) => orders.deleteDraft(ctx(req), id(req)));
  app.post("/orders/:id/send", async (req) => orders.sendOrder(ctx(req), id(req)));
  app.post("/orders/:id/reopen", async (req) => orders.reopenDraft(ctx(req), id(req)));
  app.post("/orders/:id/void", async (req) => orders.voidOrder(ctx(req), id(req)));
  app.post("/orders/:id/payments", async (req, reply) => {
    const b = parse(z.object({ amountCents: z.number(), method: Method, note: z.string().max(500).nullish(), paidAt: z.number().optional() }), req.body, reply);
    if (!b) return;
    return orders.recordPayment(ctx(req), id(req), b);
  });
  app.post("/orders/:id/refunds", { preHandler: requireOwner }, async (req, reply) => {
    const b = parse(z.object({ amountCents: z.number(), method: Method, note: z.string().max(500).nullish() }), req.body, reply);
    if (!b) return;
    return orders.refundPayment(ctx(req), id(req), b);
  });
}
