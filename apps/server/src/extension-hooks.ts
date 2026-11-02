import type { ShootScopeHook, IncomingSubfolderHook } from "./extensions.js";

/** Hooks that loaded extensions have registered. Core calls these; it never imports an extension. */
export const incomingSubfolderHooks: IncomingSubfolderHook[] = [];

/** Hooks that limit a signed-in user to certain shoots. See scope.ts. */
export const shootScopeHooks: ShootScopeHook[] = [];
