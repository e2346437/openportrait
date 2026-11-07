import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { tables } from "@openportrait/db";
import { JobRunner } from "@openportrait/jobs";
import { buildApp } from "../src/app.js";
import { queueEmail, setTransportFactory } from "../src/domain/email.js";

let app: FastifyInstance;
let root: string;
let attempts: number;
let behaviour: (n: number) => Promise<unknown>;
const quiet = { info() {}, warn() {}, error() {} };
const runner = () => new JobRunner(app.ctx.db, { logger: quiet });
const row = (id: string) => app.ctx.db.select().from(tables.emailLog).where(eq(tables.emailLog.id, id)).get()!;
const queue = () => queueEmail(app.ctx, { to: "client@example.com", subject: "Your gallery", text: "Hi", kind: "test" })!;

beforeEach(async () => {
  attempts = 0;
  behaviour = async () => ({});
  setTransportFactory(() => ({ sendMail: (async () => behaviour(++attempts)) as never }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-mail-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const s = app.ctx.settings;
  s.set("email.host", "smtp.example.com");
  s.set("email.fromAddress", "hello@example.com");
});
afterEach(async () => {
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("outgoing email is sent at most once", () => {
  it("sends a normal email exactly once, even if its job runs again", async () => {
    const id = queue();
    await runner().drain();
    expect(row(id).status).toBe("sent");
    // The same job delivered twice (a duplicate or a replay) must not send again.
    app.ctx.db.update(tables.job).set({ state: "queued", runAt: new Date() }).run();
    await runner().drain();
    expect(attempts).toBe(1);
  });

  it("does not re-send after a crash mid-send; it marks the email unconfirmed", async () => {
    const id = queue();
    // Simulate the process dying after the send began: the row is claimed, the job is left "running" and goes stale.
    app.ctx.db.update(tables.emailLog).set({ status: "sending" }).where(eq(tables.emailLog.id, id)).run();
    app.ctx.db.update(tables.job).set({ state: "running", lockedAt: new Date(Date.now() - 60 * 60_000) }).run();
    const r = new JobRunner(app.ctx.db, { logger: quiet });
    r.start();
    await r.stop();
    await runner().drain();
    expect(attempts).toBe(0);
    expect(row(id).status).toBe("unconfirmed");
    expect(row(id).error).toMatch(/Sent folder/);
  });

  it("retries when the connection never opened, and sends once when it recovers", async () => {
    behaviour = async (n) => {
      if (n === 1) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED", command: "CONN" });
      return {};
    };
    const id = queue();
    await runner().drain();
    expect(row(id).status).toBe("queued");
    app.ctx.db.update(tables.job).set({ runAt: new Date() }).run();
    await runner().drain();
    expect(row(id).status).toBe("sent");
    expect(attempts).toBe(2);
  });

  it("does not retry when the connection drops mid-send, since the client may already have it", async () => {
    behaviour = async () => {
      throw Object.assign(new Error("socket closed"), { code: "ESOCKET" });
    };
    const id = queue();
    await runner().drain();
    app.ctx.db.update(tables.job).set({ runAt: new Date() }).run();
    await runner().drain();
    expect(attempts).toBe(1);
    expect(row(id).status).toBe("unconfirmed");
  });

  it("fails for good, once, on a refused login", async () => {
    behaviour = async () => {
      throw Object.assign(new Error("bad login"), { code: "EAUTH", responseCode: 535 });
    };
    const id = queue();
    await runner().drain();
    app.ctx.db.update(tables.job).set({ runAt: new Date() }).run();
    await runner().drain();
    expect(attempts).toBe(1);
    expect(row(id).status).toBe("failed");
  });

  it("gives every email one stable Message-ID", async () => {
    const ids: string[] = [];
    setTransportFactory(() => ({ sendMail: (async (m: { messageId?: string }) => { ids.push(m.messageId!); return {}; }) as never }));
    const id = queue();
    await runner().drain();
    expect(ids).toEqual([`<${id}@example.com>`]);
  });
});
