import { defineJob, enqueue } from "@openportrait/jobs";
import type { Db } from "@openportrait/db";
import type { AppConfig } from "@openportrait/config";
import type { ServiceContext } from "../domain/context.js";
import type { Settings } from "../settings.js";
import { createGoogleApi, GoogleAuthError, type GoogleApi } from "./api.js";
import { syncGoogle, type SyncResult } from "./sync.js";

/** Builds the Google client from saved settings, or null when Google isn't connected. */
export function apiFromSettings(settings: Settings): GoogleApi | null {
  const clientId = settings.get("google.clientId");
  const clientSecret = settings.get("google.clientSecret");
  const refreshToken = settings.get("google.refreshToken");
  if (!clientId || !clientSecret || !refreshToken) return null;
  return createGoogleApi({ clientId, clientSecret }, refreshToken);
}

/** Runs one sync and records the outcome where Settings can show it. Never throws for Google-side problems. */
export async function runSync(ctx: ServiceContext, api: GoogleApi): Promise<{ ok: true; result: SyncResult } | { ok: false; message: string }> {
  try {
    const result = await syncGoogle(ctx, api);
    ctx.settings.set("google.lastSyncAt", Date.now());
    ctx.settings.delete("google.lastError");
    ctx.settings.delete("google.needsReconnect");
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.settings.set("google.lastError", message);
    if (err instanceof GoogleAuthError) ctx.settings.set("google.needsReconnect", true);
    return { ok: false, message };
  }
}

export function registerGoogleSyncJob(opts: { config: () => AppConfig; settings: () => Settings }) {
  const job = defineJob("google.sync", async (_p: Record<string, never>, { db }) => {
    const settings = opts.settings();
    const api = apiFromSettings(settings);
    if (!api || settings.get("google.needsReconnect")) return;
    const out = await runSync({ db, settings, config: opts.config(), actorId: null }, api);
    // Google being unreachable shouldn't fill the job list with retries; the next pass tries again.
    void out;
  }, { maxAttempts: 1 });

  /** Queues a sync soon. Many calls close together become one. */
  return function requestSync(db: Db, delayMs = 5000): void {
    if (!opts.settings().get("google.refreshToken") || opts.settings().get("google.needsReconnect")) return;
    enqueue(db, job, {}, { dedupeKey: "google.sync", runAt: new Date(Date.now() + delayMs) });
  };
}
