import { z } from "zod";
import * as coupons from "../../domain/coupons.js";
import * as credits from "../../domain/credits.js";
import * as orders from "../../domain/orders.js";
import * as products from "../../domain/products.js";
import { formatMoney } from "../../domain/money.js";
import { defineTool } from "../registry.js";
import { svc } from "./util.js";

// Quotes, invoices, payments and the catalog. All amounts are in cents (1250 = $12.50).
// Every tool here is in the "invoicing" capability group, so the group can be switched off as a whole.

const line = z.object({ description: z.string().min(1).max(300), quantity: z.number().int().min(1).optional(), unitCents: z.number().int().describe("Price of one, in cents."), taxable: z.boolean().optional() });

defineTool({
  name: "catalog_list",
  title: "List packages and products",
  description: "The studio's packages and products with prices in cents. Use these as the lines of a quote.",
  area: "quotes",
  capability: "invoicing",
  tier: "read",
  input: {},
  handler: (ctx) => products.listItems(svc(ctx)).map((i) => ({ id: i.id, kind: i.kind, name: i.name, description: i.description, priceCents: i.priceCents, taxable: i.taxable })),
});

defineTool({
  name: "orders_list",
  title: "List quotes and invoices",
  description: "Quotes and invoices, newest first. State is draft, sent, expired, declined, void, unpaid, partial or paid.",
  area: "orders",
  capability: "invoicing",
  tier: "read",
  input: { kind: z.enum(["quote", "invoice"]).optional(), contactId: z.string().optional(), shootId: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  handler: (ctx, a) => orders.listOrders(svc(ctx), { ...a, limit: a.limit ?? 30 }),
});

defineTool({
  name: "orders_get",
  title: "Get a quote or invoice",
  description: "One quote or invoice with its lines, payment schedule and payments.",
  area: "orders",
  capability: "invoicing",
  tier: "read",
  input: { orderId: z.string() },
  handler: (ctx, a) => {
    const { token: _t, link: _l, ...rest } = orders.getOrder(svc(ctx), a.orderId);
    return rest;
  },
});

defineTool({
  name: "quotes_create_draft",
  title: "Draft a quote",
  description: "Creates a draft quote for a contact. Nothing is sent to the client; the owner reviews it and sends it, or you can ask for it to be sent with quotes_send. Tax is added from the studio's rate.",
  area: "quotes",
  capability: "invoicing",
  tier: "draft",
  input: { contactId: z.string(), title: z.string().min(1).max(200), lines: z.array(line).min(1).max(50), shootId: z.string().optional(), discountCents: z.number().int().min(0).optional(), couponCode: z.string().max(40).optional().describe("A coupon code to apply, see coupons_list."), intro: z.string().max(3000).optional() },
  handler: (ctx, a) => {
    const q = orders.createOrder(svc(ctx), "quote", { contactId: a.contactId, title: a.title, lines: a.lines, shootId: a.shootId, discountCents: a.discountCents, couponCode: a.couponCode, intro: a.intro });
    return { orderId: q.id, label: q.label, totalCents: q.totalCents };
  },
});

defineTool({
  name: "quotes_send",
  title: "Send a quote or invoice to the client",
  description: "Sends a draft quote or invoice to the client by email with a link to view it. This reaches a client, so it waits for the owner's approval.",
  area: "quotes",
  capability: "invoicing",
  tier: "outward",
  input: { orderId: z.string() },
  summarize: (a) => `Email the client a link to their draft (${a.orderId}).`,
  handler: (ctx, a) => {
    const o = orders.sendOrder(svc(ctx), a.orderId);
    return { label: o.label, emailed: o.emailed };
  },
});

defineTool({
  name: "orders_record_payment",
  title: "Record a payment",
  description: "Records money received on a sent invoice (cash, check, Venmo and so on). This changes the studio's books, so it waits for the owner's approval.",
  area: "orders",
  capability: "invoicing",
  tier: "money",
  input: { orderId: z.string(), amountCents: z.number().int().min(1), method: z.enum(orders.METHODS), note: z.string().max(500).optional() },
  summarize: (a) => `Record a ${formatMoney(a.amountCents)} ${a.method} payment on invoice ${a.orderId}.`,
  handler: (ctx, a) => {
    const o = orders.recordPayment(svc(ctx), a.orderId, { amountCents: a.amountCents, method: a.method, note: a.note });
    return { label: o.label, paidCents: o.paidCents, balanceCents: o.balanceCents, state: o.state };
  },
});

defineTool({
  name: "coupons_list",
  title: "List coupon codes",
  description: "The studio's coupon codes with what each takes off, its expiry, use limit and how many times it has been used. Percent coupons store basis points (1000 = 10%); fixed coupons store cents.",
  area: "quotes",
  capability: "invoicing",
  tier: "read",
  input: {},
  handler: (ctx) => coupons.listCoupons(svc(ctx)).map((c) => ({ id: c.id, code: c.code, summary: c.summary, kind: c.kind, value: c.value, product: c.itemName, expiresOn: c.expiresOn, maxUses: c.maxUses, uses: c.uses, active: c.active })),
});

defineTool({
  name: "coupons_create",
  title: "Create a coupon code",
  description: "Creates a discount code. Percent: value is basis points (1000 = 10%). Fixed: value is cents. It changes what the studio charges, so it waits for the owner's approval.",
  area: "quotes",
  capability: "invoicing",
  tier: "money",
  input: { code: z.string().min(3).max(32), kind: z.enum(["percent", "fixed"]), value: z.number().int().min(1), description: z.string().max(300).optional(), itemId: z.string().optional().describe("Limit it to one catalog item."), expiresOn: z.string().optional().describe("Last day, YYYY-MM-DD."), maxUses: z.number().int().min(1).optional() },
  summarize: (a) => `Create coupon ${a.code.toUpperCase()} (${a.kind === "percent" ? `${a.value / 100}% off` : `${a.value / 100} off`}).`,
  handler: (ctx, a) => {
    const c = coupons.createCoupon(svc(ctx), a);
    return { id: c.id, code: c.code, summary: c.summary };
  },
});

defineTool({
  name: "credits_get",
  title: "Get a client's credit",
  description: "A client's credit balance in cents and their recent credit history.",
  area: "orders",
  capability: "invoicing",
  tier: "read",
  input: { contactId: z.string() },
  handler: (ctx, a) => {
    const r = credits.listCredit(svc(ctx), a.contactId);
    return { balanceCents: r.balanceCents, entries: r.entries.slice(0, 20).map((e) => ({ amountCents: e.amountCents, kind: e.kind, note: e.note, at: e.createdAt })) };
  },
});

defineTool({
  name: "credits_grant",
  title: "Add credit for a client",
  description: "Adds credit to a client's balance, for example a gift card or a prepayment. It is money the studio owes the client, so it waits for the owner's approval.",
  area: "orders",
  capability: "invoicing",
  tier: "money",
  input: { contactId: z.string(), amountCents: z.number().int().min(1), note: z.string().max(300).optional() },
  summarize: (a) => `Add ${(a.amountCents / 100).toFixed(2)} of credit for contact ${a.contactId}${a.note ? ` (${a.note})` : ""}.`,
  handler: (ctx, a) => ({ balanceCents: credits.grantCredit(svc(ctx), a.contactId, a).balanceCents }),
});

defineTool({
  name: "orders_apply_credit",
  title: "Pay an invoice from the client's credit",
  description: "Uses the client's credit toward a sent invoice. Without an amount it uses as much as it can. It records a payment, so it waits for the owner's approval.",
  area: "orders",
  capability: "invoicing",
  tier: "money",
  input: { orderId: z.string(), amountCents: z.number().int().min(1).optional() },
  summarize: (a) => `Pay invoice ${a.orderId} from the client's credit${a.amountCents ? ` (${(a.amountCents / 100).toFixed(2)})` : ""}.`,
  handler: (ctx, a) => credits.applyCredit(svc(ctx), a.orderId, a.amountCents),
});
