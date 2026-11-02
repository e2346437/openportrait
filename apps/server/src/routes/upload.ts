import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tables } from "@openportrait/db";
import { requireOwner, requireUser } from "../auth.js";
import { isLocalHostName, lanHosts } from "../lan.js";
import { DomainError } from "../domain/context.js";
import { parse } from "../validate.js";
import { scheduleProblem } from "../upload/schedule.js";
import { readFtpsCert } from "../upload/tls.js";

const Window = z.object({
  days: z.array(z.number().int().min(0).max(6)).max(7),
  start: z.string(),
  end: z.string(),
});

const SettingsBody = z.object({
  protocol: z.enum(["sftp", "ftp", "ftps"]),
  mode: z.enum(["on_demand", "scheduled", "always_on"]),
  idleMinutes: z.number().int().min(5, "Use at least 5 minutes.").max(720, "Use at most 12 hours."),
  schedule: z.array(Window).max(14),
  sortByDay: z.boolean(),
  passiveHost: z
    .string()
    .trim()
    .max(253)
    .refine((v) => v === "" || /^[A-Za-z0-9.-]+$/.test(v), "Enter an IP address or host name, like 192.168.1.20."),
  /** Required when switching to always-on, so it can't be turned on by accident. */
  confirmAlwaysOn: z.boolean().optional(),
});

const NewCamera = z.object({
  label: z.string().trim().min(1, "Name the camera, for example Nikon Z9.").max(60),
  username: z.string().trim().max(32).optional(),
  publicKey: z.string().trim().max(4000).optional(),
});

const EditCamera = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  publicKey: z.string().trim().max(4000).nullable().optional(),
  disabled: z.boolean().optional(),
});

/** Settings > Camera upload: protocol, when the server is open, and the per-camera logins. */
export async function uploadRoutes(app: FastifyInstance) {
  const { settings, config, uploads } = app.ctx;
  const audit = (userId: string, action: string, detail: object, ip: string) =>
    app.ctx.db.insert(tables.auditLog).values({ userId, action, detail, ip }).run();

  /** Opened by any signed-in page that needs cameras to be able to upload, such as the live view. */
  app.post("/demand", { preHandler: requireUser }, async () => {
    uploads.demand();
    return uploads.status();
  });

  app.register(async (owner) => {
    owner.addHook("preHandler", requireOwner);

    const snapshot = (hostHint: string) => ({
      status: uploads.status(),
      settings: {
        protocol: uploads.protocol(),
        mode: uploads.mode(),
        idleMinutes: uploads.idleMinutes(),
        schedule: uploads.schedule(),
        sortByDay: uploads.sortByDay(),
        passiveHost: uploads.passiveHost(),
      },
      timezone: uploads.timezone(),
      accounts: uploads.accounts.list().map((a) => ({
        id: a.id,
        label: a.label,
        username: a.username,
        folder: a.folder,
        hasKey: Boolean(a.publicKey),
        disabled: Boolean(a.disabledAt),
        createdAt: a.createdAt.getTime(),
        lastLoginAt: a.lastLoginAt?.getTime() ?? null,
        lastUploadAt: a.lastUploadAt?.getTime() ?? null,
        filesReceived: a.filesReceived,
        bytesReceived: a.bytesReceived,
      })),
      events: uploads.recentEvents(15),
      connect: {
        hosts: [...new Set([...lanHosts(settings, config), isLocalHostName(hostHint) ? hostHint : ""].filter(Boolean))],
        lanConfigured: app.ctx.lan().url !== null,
        sftpPort: config.sftpPort,
        ftpPort: config.ftpPort,
        passiveMin: config.ftpPassiveMin,
        passiveMax: config.ftpPassiveMax,
        fingerprint: uploads.hostFingerprint(),
        hasCert: readFtpsCert(config.configDir) !== null,
      },
    });

    owner.get("/", async (req) => snapshot(req.hostname.replace(/:\d+$/, "")));

    owner.put("/settings", async (req, reply) => {
      const body = parse(SettingsBody, req.body, reply);
      if (!body) return;
      const problem = scheduleProblem(body.schedule);
      if (problem) return reply.code(400).send({ error: "invalid", field: "schedule", message: problem });
      if (body.mode === "always_on" && uploads.mode() !== "always_on" && !body.confirmAlwaysOn) {
        return reply.code(400).send({ error: "confirm_required", field: "mode", message: "Confirm that you want the upload server open all the time." });
      }
      if (body.mode === "scheduled" && body.schedule.length === 0) {
        return reply.code(400).send({ error: "invalid", field: "schedule", message: "Add at least one time window, or choose another access mode." });
      }
      const before = { protocol: uploads.protocol(), mode: uploads.mode() };
      settings.set("upload.protocol", body.protocol);
      settings.set("upload.mode", body.mode);
      settings.set("upload.idleMinutes", body.idleMinutes);
      settings.set("upload.schedule", body.schedule);
      settings.set("upload.sortByDay", body.sortByDay);
      settings.set("upload.passiveHost", body.passiveHost);
      audit(req.user!.id, "upload.settings", { from: before, to: { protocol: body.protocol, mode: body.mode } }, app.ctx.ip(req));
      await uploads.refresh();
      return snapshot(req.hostname.replace(/:\d+$/, ""));
    });

    const Open = z.object({ minutes: z.number().int().min(1).max(1440).default(60) });
    owner.post("/open", async (req, reply) => {
      const body = parse(Open, req.body ?? {}, reply);
      if (!body) return;
      await uploads.openFor(body.minutes);
      return uploads.status();
    });
    owner.post("/close", async (req) => {
      await uploads.closeNow();
      return uploads.status();
    });

    owner.post("/accounts", async (req, reply) => {
      const body = parse(NewCamera, req.body, reply);
      if (!body) return;
      const created = await uploads.accounts.create(body);
      audit(req.user!.id, "upload.camera_added", { label: created.account.label, username: created.account.username }, app.ctx.ip(req));
      return { id: created.account.id, label: created.account.label, username: created.account.username, folder: created.account.folder, password: created.password };
    });
    owner.patch("/accounts/:id", async (req, reply) => {
      const body = parse(EditCamera, req.body, reply);
      if (!body) return;
      const id = (req.params as { id: string }).id;
      uploads.accounts.update(id, body);
      audit(req.user!.id, "upload.camera_changed", { id, ...body, publicKey: body.publicKey ? "(set)" : body.publicKey }, app.ctx.ip(req));
      return { ok: true };
    });
    owner.post("/accounts/:id/reset-password", async (req) => {
      const id = (req.params as { id: string }).id;
      const password = await uploads.accounts.resetPassword(id);
      audit(req.user!.id, "upload.camera_password_reset", { id }, app.ctx.ip(req));
      return { password };
    });
    owner.delete("/accounts/:id", async (req) => {
      const id = (req.params as { id: string }).id;
      uploads.accounts.remove(id);
      audit(req.user!.id, "upload.camera_removed", { id }, app.ctx.ip(req));
      return { ok: true };
    });

    owner.get("/ftps-certificate", async (_req, reply) => {
      const pem = readFtpsCert(config.configDir);
      if (!pem) throw new DomainError("not_found", "The certificate is created the first time the FTPS server opens. Open the server once, then download it.", 404);
      return reply.header("Content-Type", "application/x-pem-file").header("Content-Disposition", 'attachment; filename="openportrait-camera-upload.pem"').send(pem);
    });
  });
}
