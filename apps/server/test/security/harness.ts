import dc from "node:diagnostics_channel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../../src/app.js";

/**
 * Shared setup for the security regression suite. Everything here uses synthetic data in a throwaway
 * directory, so it is safe to run anywhere (a laptop, CI, a sandbox). It never touches a real install.
 *
 * Findings that are still open are written as `openFinding(...)`: the test asserts the SECURE behaviour and is
 * expected to fail today (vitest `it.fails`). When the fix lands the test starts passing, vitest reports the
 * `it.fails` as a failure, and the person fixing it flips `openFinding` to `it`. That keeps CI green while a
 * finding is documented, and makes it impossible to fix one silently.
 * Run with SECURITY_STRICT=1 to see the real failures (the "fails before the fix" evidence).
 */
import { it } from "vitest";

export const OWNER = { studioName: "Audit Studio", ownerName: "Owner A", email: "owner-a@audit.invalid", password: "synthetic-Pass-12345", timezone: "UTC" };

export interface Deployment {
  app: FastifyInstance;
  root: string;
  cookie: string;
  routes: Array<{ method: string; url: string }>;
  close(): Promise<void>;
}

/** Builds an app and records every route it registers (Fastify announces the instance on a diagnostics channel). */
export async function boot(name = "a", env: Record<string, string> = {}): Promise<Deployment> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `op-sec-${name}-`));
  const routes: Array<{ method: string; url: string }> = [];
  const onInit = (msg: unknown) => {
    const fastify = (msg as { fastify: FastifyInstance }).fastify;
    fastify.addHook("onRoute", (r) => {
      for (const method of [r.method].flat()) if (method !== "HEAD" && method !== "OPTIONS") routes.push({ method, url: r.url });
    });
  };
  const ch = dc.channel("fastify.initialization");
  ch.subscribe(onInit);
  let app: FastifyInstance;
  try {
    const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), ...env });
    app = await buildApp({ config, startBackground: false, logger: false });
  } finally {
    ch.unsubscribe(onInit);
  }
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { ...OWNER, email: `owner-${name}@audit.invalid` } });
  const c = res.cookies.find((x) => x.name === "op_session");
  return {
    app,
    root,
    routes,
    cookie: c ? `op_session=${c.value}` : "",
    async close() {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An open finding: asserts the secure behaviour, expected to fail until the fix lands. */
export const openFinding = (id: string, title: string, fn: () => Promise<void> | void) =>
  process.env.SECURITY_STRICT === "1" ? it(`${id} ${title}`, fn) : it.fails(`${id} (OPEN) ${title}`, fn);
/** A control that was tested and held. */
export const control = (id: string, title: string, fn: () => Promise<void> | void) => it(`${id} ${title}`, fn);

export const json = (res: { body: string }) => JSON.parse(res.body);
