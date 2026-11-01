import nodemailer, { type Transporter } from "nodemailer";
import { tables, type Db } from "@openportrait/db";
import type { Logger } from "@openportrait/jobs";
import { newId } from "../galleries/files.js";
import type { Settings } from "../settings.js";

export interface Outgoing {
  kind: string;
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  contactId?: string | null;
  shootId?: string | null;
  galleryId?: string | null;
}

export type SendResult = { ok: true; id: string } | { ok: false; id: string; error: string };

/** Sends mail through the studio's own SMTP account and keeps a log of everything it tried. */
export class Mailer {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly logger: Logger,
    /** Tests pass a transport that records mail instead of sending it. */
    private readonly override?: Transporter,
  ) {}

  configured(): boolean {
    return !!this.override || !!(this.settings.get("email.host") && this.settings.get("email.fromAddress"));
  }

  private transport(): Transporter {
    if (this.override) return this.override;
    const secure = this.settings.get("email.security") ?? "starttls";
    const user = this.settings.get("email.user");
    return nodemailer.createTransport({
      host: this.settings.get("email.host"),
      port: this.settings.get("email.port") ?? (secure === "tls" ? 465 : 587),
      secure: secure === "tls",
      requireTLS: secure === "starttls",
      ignoreTLS: secure === "none",
      auth: user ? { user, pass: this.settings.get("email.password") ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  from(): string {
    const name = (this.settings.get("email.fromName") || this.settings.get("studio.name") || "").replace(/["\r\n]/g, "");
    const address = this.settings.get("email.fromAddress") ?? "";
    return name ? `"${name}" <${address}>` : address;
  }

  async send(mail: Outgoing): Promise<SendResult> {
    const id = newId();
    const log = (status: "sent" | "failed", error?: string) =>
      this.db
        .insert(tables.message)
        .values({ id, kind: mail.kind, toEmail: mail.to, toName: mail.toName ?? null, subject: mail.subject, body: mail.text, status, error: error ?? null, contactId: mail.contactId ?? null, shootId: mail.shootId ?? null, galleryId: mail.galleryId ?? null })
        .run();
    if (!this.configured()) {
      log("failed", "Email isn't set up yet. Add your SMTP details in Settings › Email.");
      return { ok: false, id, error: "Email isn't set up yet. Add your SMTP details in Settings › Email." };
    }
    try {
      await this.transport().sendMail({ from: this.from(), to: mail.toName ? `"${mail.toName.replace(/["\r\n]/g, "")}" <${mail.to}>` : mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: mail.replyTo ?? (this.settings.get("email.replyTo") || undefined) });
      log("sent");
      return { ok: true, id };
    } catch (err) {
      const error = friendly(err);
      this.logger.warn({ err: String(err), kind: mail.kind }, "email failed");
      log("failed", error);
      return { ok: false, id, error };
    }
  }
}

/** The text a studio can act on, instead of a stack of SMTP codes. */
function friendly(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === "EAUTH" || e.responseCode === 535) return "The mail server refused the username or password.";
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "ETIMEDOUT" || e.code === "ESOCKET" || e.code === "ECONNECTION") return "Couldn't reach the mail server. Check the host, port and security setting.";
  return e.message ? `The mail server said: ${e.message.slice(0, 200)}` : "The email couldn't be sent.";
}
