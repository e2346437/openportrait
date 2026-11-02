import { z } from "zod";
import * as contracts from "../../domain/contracts.js";
import { defineTool } from "../registry.js";
import { svc } from "./util.js";

// Contracts and e-signatures. The capability group is "contracts".
// Merge fields look like {{client.name}}; the template editor lists them all.

defineTool({
  name: "contract_templates_list",
  title: "List contract templates",
  description: "The studio's contract templates, with their wording. Use a template's id to draft a contract.",
  area: "contracts",
  capability: "contracts",
  tier: "read",
  input: {},
  handler: (ctx) => contracts.listTemplates(svc(ctx)).map((t) => ({ id: t.id, name: t.name, body: t.body })),
});

defineTool({
  name: "contracts_list",
  title: "List contracts",
  description: "Contracts, newest first. State is draft, sent, signed, countersigned or void.",
  area: "contracts",
  capability: "contracts",
  tier: "read",
  input: { contactId: z.string().optional(), shootId: z.string().optional(), status: z.enum(["draft", "sent", "signed", "void"]).optional(), limit: z.number().int().min(1).max(100).optional() },
  handler: (ctx, a) => contracts.listContracts(svc(ctx), { ...a, limit: a.limit ?? 30 }),
});

defineTool({
  name: "contracts_get",
  title: "Get a contract",
  description: "One contract with its full text and signing status.",
  area: "contracts",
  capability: "contracts",
  tier: "read",
  input: { contractId: z.string() },
  handler: (ctx, a) => {
    const { link: _l, ...rest } = contracts.getContract(svc(ctx), a.contractId);
    return rest;
  },
});

defineTool({
  name: "contracts_create_draft",
  title: "Draft a contract from a template",
  description: "Creates a draft contract for a contact from a template, filling in merge fields. Link a shoot or quote if the template uses shoot or order fields. Nothing is sent; the owner reviews it and sends it, or you can ask for it to be sent with contracts_send.",
  area: "contracts",
  capability: "contracts",
  tier: "draft",
  input: { contactId: z.string(), templateId: z.string(), shootId: z.string().optional(), orderId: z.string().optional(), title: z.string().max(200).optional() },
  handler: (ctx, a) => {
    const c = contracts.createContract(svc(ctx), a);
    return { contractId: c.id, title: c.title, state: c.state };
  },
});

defineTool({
  name: "contracts_send",
  title: "Send a contract to the client to sign",
  description: "Emails the client a link to review and sign a draft contract. This reaches a client, so it waits for the owner's approval.",
  area: "contracts",
  capability: "contracts",
  tier: "outward",
  input: { contractId: z.string() },
  summarize: (a) => `Email the client a link to sign contract ${a.contractId}.`,
  handler: (ctx, a) => {
    const r = contracts.sendContract(svc(ctx), a.contractId);
    return { title: r.title, emailed: r.emailed };
  },
});
