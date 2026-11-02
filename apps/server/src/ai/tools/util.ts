import type { AppContext } from "../../app.js";
import type { ServiceContext } from "../../domain/context.js";

/** The context domain services need. AI actions have no staff user, so activity shows as "system". */
export const svc = (ctx: AppContext): ServiceContext => ({ db: ctx.db, settings: ctx.settings, config: ctx.config, actorId: null });

/**
 * Wraps text a client wrote (inquiry messages, notes) so the assistant treats it as data. Anyone can type
 * anything into a contact form, including instructions aimed at an AI. Angle brackets inside are escaped, so the text
 * can't close the wrapper early and pose as something outside it (SEC-006).
 */
export const untrusted = (text: string | null | undefined) =>
  text ? `<untrusted_client_text>${text.replace(/</g, "&lt;")}</untrusted_client_text>` : null;

/**
 * Short outside-sourced values such as names, companies, subjects and places. They stay compact, but can't carry
 * line breaks or markup, so a name can't turn into a paragraph of instructions. Long free text goes through untrusted().
 */
export const plain = <T extends string | null | undefined>(text: T): T =>
  (typeof text === "string" ? text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/</g, "‹").replace(/>/g, "›").slice(0, 200) : text) as T;

const iso = (d: Date | number | null | undefined) => (d == null ? null : new Date(d).toISOString());
export { iso };
