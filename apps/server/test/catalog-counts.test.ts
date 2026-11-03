import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { listShootTypes, listStages } from "../src/domain/catalog.js";
import { createLead } from "../src/domain/leads.js";
import { createShoot } from "../src/domain/shoots.js";

let app: FastifyInstance;
const svc = () => ({ db: app.ctx.db, settings: app.ctx.settings, config: app.ctx.config, actorId: null });

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-catalog-"));
  app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") }), startBackground: false, setupCode: null, logger: false });
});
afterEach(async () => {
  await app.close();
});

describe("catalog usage counts", () => {
  it("counts shoots per shoot type and leads per stage", () => {
    const { lead } = createLead(svc(), { contact: { firstName: "Dana", lastName: "Reyes", email: "dana@example.com" } });
    const type = listShootTypes(svc())[0]!;
    createShoot(svc(), { primaryContactId: lead.contactId, shootTypeId: type.id, subject: "Reyes family", events: [{ startsAt: Date.now() + 86_400_000, endsAt: Date.now() + 90_000_000 }] });
    const types = listShootTypes(svc());
    expect(types.find((t) => t.id === type.id)!.shoots).toBe(1);
    expect(types.filter((t) => t.id !== type.id).every((t) => t.shoots === 0)).toBe(true);
    const stages = listStages(svc());
    expect(stages.find((s) => s.id === lead.stageId)!.leads).toBe(1);
    expect(stages.reduce((n, s) => n + s.leads, 0)).toBe(1);
  });
});
