import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth.js";
import { DEFAULT_TEMPLATES, MERGE_FIELDS, fill, renderEmail, templateFor } from "../email/templates.js";
import { email, parse } from "../validate.js";

const Body = z.object({
  host: z.string().trim().max(200),
  port: z.number().int().min(1).max(65535).nullable(),
  security: z.enum(["starttls", "tls", "none"]),
  user: z.string().trim().max(200),
  /** Empty keeps the saved password. */
  password: z.string().max(500).optional(),
  fromName: z.string().trim().max(120),
  fromAddress: email.or(z.literal("")),
  replyTo: email.or(z.literal("")),
  galleryReady: z.object({ subject: z.string().trim().min(1, "Give the email a subject.").max(200), body: z.string().trim().min(1, "Write the email.").max(4000) }),
  notifyOnSubmit: z.boolean(),
});

export async function emailRoutes(app: FastifyInstance) {
  const { settings, mailer } = app.ctx;

  const view = () => {
    const t = templateFor(settings, "galleryReady");
    return {
      host: settings.get("email.host") ?? "",
      port: settings.get("email.port") ?? null,
      security: settings.get("email.security") ?? "starttls",
      user: settings.get("email.user") ?? "",
      hasPassword: !!settings.get("email.password"),
      fromName: settings.get("email.fromName") ?? "",
      fromAddress: settings.get("email.fromAddress") ?? "",
      replyTo: settings.get("email.replyTo") ?? "",
      configured: mailer.configured(),
      galleryReady: t,
      defaults: { galleryReady: DEFAULT_TEMPLATES.galleryReady },
      mergeFields: MERGE_FIELDS,
      notifyOnSubmit: settings.get("galleries.notifyOnSubmit") !== false,
    };
  };

  app.get("/settings", { preHandler: requireUser }, async () => view());

  app.put("/settings", { preHandler: requireOwner }, async (req, reply) => {
    const body = parse(Body, req.body, reply);
    if (!body) return;
    settings.set("email.host", body.host);
    if (body.port) settings.set("email.port", body.port);
    else settings.delete("email.port");
    settings.set("email.security", body.security);
    settings.set("email.user", body.user);
    if (body.password) settings.set("email.password", body.password);
    if (!body.user) settings.delete("email.password");
    settings.set("email.fromName", body.fromName);
    settings.set("email.fromAddress", body.fromAddress);
    settings.set("email.replyTo", body.replyTo);
    settings.set("email.template.galleryReady", body.galleryReady);
    settings.set("galleries.notifyOnSubmit", body.notifyOnSubmit);
    return view();
  });

  /** Sends a sample gallery email to the signed-in person, so the studio sees exactly what clients get. */
  app.post("/test", { preHandler: requireOwner }, async (req) => {
    const studioName = settings.get("studio.name") ?? "";
    const t = templateFor(settings, "galleryReady");
    const values = { client_name: req.user!.name.split(/\s+/)[0] || "there", gallery_title: "Sample gallery", gallery_link: `${app.ctx.publicUrl()}/g/sample`, studio_name: studioName, message: "This is a test email from OpenPortrait." };
    const mail = renderEmail({ studioName, body: fill(t.body, values), button: { label: "View your gallery", url: values.gallery_link } });
    const res = await mailer.send({ kind: "test", to: req.user!.email, toName: req.user!.name, subject: `Test: ${fill(t.subject, values)}`, text: mail.text, html: mail.html });
    return res.ok ? { ok: true, to: req.user!.email } : { ok: false, error: res.error };
  });
}
