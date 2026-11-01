import crypto from "node:crypto";
import type { AppConfig } from "@openportrait/config";
import type { Db } from "@openportrait/db";
import type { Settings } from "../settings.js";

/**
 * What every domain service needs. The HTTP routes build one per request from the signed-in user;
 * the MCP tools and background jobs build their own. `actorId` is the staff user, or null for the system.
 */
export interface ServiceContext {
  db: Db;
  settings: Settings;
  config: AppConfig;
  actorId: string | null;
}

/** A refusal with a message that is safe to show to the person using the app. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what} not found.`, 404);

export const newId = () => crypto.randomUUID();
