import type { AppContext } from "../../app.js";
import type { ServiceContext } from "../../domain/context.js";

/** The context domain services need. AI actions have no staff user, so activity shows as "system". */
export const svc = (ctx: AppContext): ServiceContext => ({ db: ctx.db, settings: ctx.settings, config: ctx.config, actorId: null });

/**
 * Wraps text a client wrote (inquiry messages, notes) so the assistant treats it as data. Anyone can type
 * anything into a contact form, including instructions aimed at an AI.
 */
export const untrusted = (text: string | null | undefined) => (text ? `<untrusted_client_text>${text}</untrusted_client_text>` : null);

const iso = (d: Date | number | null | undefined) => (d == null ? null : new Date(d).toISOString());
export { iso };
