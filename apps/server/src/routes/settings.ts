import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import { email, parse, timezone } from "../validate.js";

const EMPTY = { street: "", unit: "", city: "", state: "", postal: "" };
const text = (max: number) => z.string().trim().max(max).default("");
const Address = z.object({ street: text(160), unit: text(60), city: text(80), state: text(60), postal: text(20) });
const Hours = z.object({
  days: z
    .array(z.object({ open: z.boolean(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }))
    .length(7),
  note: text(200),
});
const StudioBody = z.object({
  name: z.string().trim().min(1, "Enter your studio's name.").max(120),
  email,
  timezone,
  phone: text(40),
  website: text(200),
  physicalAddress: Address.default(EMPTY),
  /** Null means the mailing address is the same as the physical address. */
  mailingAddress: Address.nullable().default(null),
  showAddress: z.boolean().default(false),
  /** Null means hours of operation are not shown. */
  hours: Hours.nullable().default(null),
});

export async function settingsRoutes(app: FastifyInstance) {
  const { settings } = app.ctx;

  app.get("/studio", { preHandler: requireUser }, async () => ({
    name: settings.get("studio.name") ?? "",
    email: settings.get("studio.email") ?? "",
    timezone: settings.get("studio.timezone") ?? "UTC",
    phone: settings.get("studio.phone") ?? "",
    website: settings.get("studio.website") ?? "",
    physicalAddress: settings.get("studio.physicalAddress") ?? EMPTY,
    mailingAddress: settings.get("studio.mailingAddress") ?? null,
    showAddress: settings.get("studio.showAddress") ?? false,
    hours: settings.get("studio.hours") ?? null,
  }));

  app.put("/studio", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(StudioBody, req.body, reply);
    if (!body) return;
    settings.set("studio.name", body.name);
    settings.set("studio.email", body.email);
    settings.set("studio.timezone", body.timezone);
    settings.set("studio.phone", body.phone);
    settings.set("studio.website", body.website);
    settings.set("studio.physicalAddress", body.physicalAddress);
    if (body.mailingAddress) settings.set("studio.mailingAddress", body.mailingAddress);
    else settings.delete("studio.mailingAddress");
    settings.set("studio.showAddress", body.showAddress);
    if (body.hours) settings.set("studio.hours", body.hours);
    else settings.delete("studio.hours");
    return body;
  });
}
