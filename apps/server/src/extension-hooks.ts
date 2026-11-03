import type { BackupProvider, IncomingSubfolderHook, MailSender, ShootScopeHook } from "./extensions.js";

/** Hooks that loaded extensions have registered. Core calls these; it never imports an extension. */
export const incomingSubfolderHooks: IncomingSubfolderHook[] = [];

/** Hooks that limit a signed-in user to certain shoots. See scope.ts. */
export const shootScopeHooks: ShootScopeHook[] = [];

/** Mail senders that loaded extensions have registered. When one is ready, outgoing email goes through it instead of SMTP. */
export const mailSenders: MailSender[] = [];

/** Places backups can be copied to that loaded extensions have added, such as a cloud bucket. The built-in folder destination lives in backup-destinations.ts. */
export const backupProviders: BackupProvider[] = [];
