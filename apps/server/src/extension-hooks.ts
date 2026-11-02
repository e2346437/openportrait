import type { IncomingSubfolderHook, MailSender } from "./extensions.js";

/** Hooks that loaded extensions have registered. Core calls these; it never imports an extension. */
export const incomingSubfolderHooks: IncomingSubfolderHook[] = [];

/** Mail senders that loaded extensions have registered. When one is ready, outgoing email goes through it instead of SMTP. */
export const mailSenders: MailSender[] = [];
