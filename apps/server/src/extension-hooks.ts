import type { IncomingSubfolderHook } from "./extensions.js";

/** Hooks that loaded extensions have registered. Core calls these; it never imports an extension. */
export const incomingSubfolderHooks: IncomingSubfolderHook[] = [];
