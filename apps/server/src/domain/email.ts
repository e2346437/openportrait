import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { tables, type Db } from "@openportrait/db";
import { defineJob, enqueue } from "@openportrait/jobs";
import type { Settings } from "../settings.js";
import { DomainError, type ServiceContext } from "./context.js";
import { mailSenders } from "../extension-hooks.js";

const { emailLog } = tables;

export interface EmailConfig {
  host: string;
  port: number;
  security: "none" | "starttls" | "tls";
  user: string;
  password: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The saved SMTP settings, or null until a server and sender address are set. */
export function getEmailConfig(settings: Settings): EmailConfig | null {
  const host = settings.get("email.host");
  const fromAddress = settings.get("email.fromAddress");
  if (!host || !fromAddress) return null;
  return {
    host,
    port: settings.get("email.port") ?? 587,
    security: settings.get("email.security") ?? "starttls",
    user: settings.get("email.user") ?? "",
    password: settings.get("email.password") ?? "",
    fromName: settings.get("email.fromName") || settings.get("studio.name") || "",
    fromAddress,
    replyTo: settings.get("email.replyTo") ?? "",
  };
}

/** What the settings screen shows: everything except the password. */
export function emailSettingsView(settings: Settings) {
  const c = getEmailConfig(settings);
  return {
    configured: !!c || !!outsideSender(),
    outside: outsideSender()?.label ?? null,
    host: settings.get("email.host") ?? "",
    port: settings.get("email.port") ?? 587,
    security: settings.get("email.security") ?? "starttls",
    user: settings.get("email.user") ?? "",
    hasPassword: !!settings.get("email.password"),
    fromName: settings.get("email.fromName") ?? "",
    fromAddress: settings.get("email.fromAddress") ?? "",
    replyTo: settings.get("email.replyTo") ?? "",
  };
}

export interface EmailSettingsInput {
  host: string;
  port: number;
  security: "none" | "starttls" | "tls";
  user?: string;
  /** Omitted or blank keeps the saved password. */
  password?: string;
  fromName?: string;
  fromAddress: string;
  replyTo?: string;
}

export function saveEmailSettings(ctx: ServiceContext, input: EmailSettingsInput) {
  const host = input.host.trim();
  if (!host) throw new DomainError("invalid", "Enter your email provider's server name, such as smtp.example.com.");
  if (!EMAIL.test(input.fromAddress.trim())) throw new DomainError("invalid", "Enter the address emails should come from.");
  if (input.replyTo?.trim() && !EMAIL.test(input.replyTo.trim())) throw new DomainError("invalid", "The reply-to address isn't valid.");
  const s = ctx.settings;
  s.set("email.host", host);
  s.set("email.port", input.port);
  s.set("email.security", input.security);
  s.set("email.user", input.user?.trim() ?? "");
  if (input.password) s.set("email.password", input.password);
  s.set("email.fromName", input.fromName?.trim() ?? "");
  s.set("email.fromAddress", input.fromAddress.trim());
  s.set("email.replyTo", input.replyTo?.trim() ?? "");
}

/** The outside mailbox an extension offers, when one is connected. */
export function outsideSender() {
  return mailSenders.find((m) => m.ready()) ?? null;
}

/** True when email can go out, by SMTP or through an extension's mailbox. */
export function emailConfigured(settings: Settings): boolean {
  return !!getEmailConfig(settings) || !!outsideSender();
}

// ---- sending ----

export type TransportFactory = (config: EmailConfig) => Pick<Transporter, "sendMail">;

const smtp: TransportFactory = (c) =>
  nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === "tls",
    requireTLS: c.security === "starttls",
    ignoreTLS: c.security === "none",
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

let factory: TransportFactory = smtp;
/** Tests swap in a fake mailbox. */
export function setTransportFactory(f: TransportFactory | null): void {
  factory = f ?? smtp;
}

/** Turns what SMTP servers say into something a photographer can act on. */
export function friendlyEmailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === "EAUTH" || e.responseCode === 535) return "The email server refused the username or password. For Gmail and similar, use an app password, not your normal one.";
  if (e.code === "ECONNREFUSED") return "Couldn't connect to the email server. Check the server name and port.";
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return "The email server name wasn't found. Check it for typos.";
  if (e.code === "ETIMEDOUT" || e.code === "ESOCKET" || e.code === "ECONNECTION") return "The email server didn't answer. Check the port and the security setting, and that this server can make outgoing connections.";
  if (e.responseCode === 550 || e.responseCode === 553) return "The email server rejected the sender or recipient address. The From address often has to belong to your email account.";
  return e.message || "The email couldn't be sent.";
}

export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html?: string;
  kind?: string;
  contactId?: string | null;
  shootId?: string | null;
  galleryId?: string | null;
}

/**
 * Queues an email and records it. Returns null when email isn't set up, so callers that send as a
 * courtesy (a thank-you after an inquiry) can carry on without it.
 */
export function queueEmail(ctx: { db: Db; settings: Settings }, mail: OutgoingEmail): string | null {
  if (!emailConfigured(ctx.settings)) return null;
  if (!EMAIL.test(mail.to)) return null;
  const id = crypto.randomUUID();
  ctx.db.insert(emailLog).values({ id, toAddress: mail.to, toName: mail.toName ?? null, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html ?? null, kind: mail.kind ?? "other", contactId: mail.contactId ?? null, shootId: mail.shootId ?? null, galleryId: mail.galleryId ?? null }).run();
  enqueue(ctx.db, "email.send", { id });
  return id;
}

async function deliver(db: Db, settings: Settings, id: string): Promise<void> {
  const row = db.select().from(emailLog).where(eq(emailLog.id, id)).get();
  if (!row || row.status === "sent") return;
  const outside = outsideSender();
  const config = getEmailConfig(settings);
  if (!config && !outside) {
    db.update(emailLog).set({ status: "failed", error: "Email isn't set up." }).where(eq(emailLog.id, id)).run();
    return;
  }
  try {
    if (outside) {
      await outside.send({ fromName: config?.fromName || settings.get("studio.name") || "", to: row.toAddress, toName: row.toName, replyTo: config?.replyTo || undefined, subject: row.subject, text: row.bodyText, html: row.bodyHtml ?? undefined });
    } else if (config) await factory(config).sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to: row.toName ? { name: row.toName, address: row.toAddress } : row.toAddress,
      replyTo: config.replyTo || undefined,
      subject: row.subject,
      text: row.bodyText,
      html: row.bodyHtml ?? undefined,
    });
    db.update(emailLog).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(emailLog.id, id)).run();
  } catch (err) {
    const message = friendlyEmailError(err);
    db.update(emailLog).set({ status: "failed", error: message }).where(eq(emailLog.id, id)).run();
    // A wrong password won't fix itself, so don't retry those; network trouble is worth another try.
    const permanent = (err as { code?: string }).code === "EAUTH" || ((err as { responseCode?: number }).responseCode ?? 0) >= 500;
    if (!permanent) throw err;
  }
}

export function registerEmailJob(settings: () => Settings) {
  defineJob("email.send", async (p: { id: string }, { db }) => deliver(db, settings(), p.id), { maxAttempts: 4 });
}

/** Sends one now and waits, so the settings screen can show the real error. */
export async function sendTestEmail(ctx: ServiceContext, to: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const outside = outsideSender();
  const config = getEmailConfig(ctx.settings);
  if (!config && !outside) throw new DomainError("not_configured", "Save your email settings first.");
  try {
    if (outside) {
      await outside.send({ fromName: config?.fromName || ctx.settings.get("studio.name") || "", to, subject: "Test email from OpenPortrait", text: "This is a test. If you're reading it, OpenPortrait can send email." });
      return { ok: true };
    }
    if (!config) throw new Error("Email isn't set up.");
    await factory(config).sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to,
      replyTo: config.replyTo || undefined,
      subject: "Test email from OpenPortrait",
      text: "This is a test. If you're reading it, OpenPortrait can send email.",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: friendlyEmailError(err) };
  }
}

export function recentEmails(ctx: ServiceContext, limit = 50) {
  return ctx.db
    .select({ id: emailLog.id, toAddress: emailLog.toAddress, subject: emailLog.subject, kind: emailLog.kind, status: emailLog.status, error: emailLog.error, createdAt: emailLog.createdAt, sentAt: emailLog.sentAt, contactId: emailLog.contactId, shootId: emailLog.shootId, galleryId: emailLog.galleryId })
    .from(emailLog)
    .orderBy(desc(emailLog.createdAt))
    .limit(Math.min(limit, 200))
    .all();
}

// ---- layout ----

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain, readable email: the studio's name, some paragraphs, an optional button. Works in dark mode and old clients. */
export function composeEmail(studio: string, paragraphs: string[], action?: { label: string; url: string }): { text: string; html: string } {
  const text = [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : []), `\n${studio}`].join("\n\n");
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;line-height:1.55">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const button = action ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="background:#171613;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">${esc(action.label)}</a></p><p style="margin:0 0 16px;font-size:13px;color:#6b655b">Or paste this into your browser:<br>${esc(action.url)}</p>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f3eee5;padding:24px"><div style="max-width:560px;margin:0 auto;background:#ffffff;color:#171613;border-radius:14px;padding:32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px"><p style="margin:0 0 24px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b655b">${esc(studio)}</p>${body}${button}</div></body></html>`;
  return { text, html };
}
