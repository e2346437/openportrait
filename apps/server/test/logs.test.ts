import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { createLogStream, parseLine, readLog, redact } from "../src/logs.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-logs-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const line = (level: number, msg: string, extra: object = {}) => JSON.stringify({ level, time: 1_700_000_000_000 + level, msg, ...extra }) + "\n";

describe("log file", () => {
  it("masks private link tokens but keeps ordinary ids", () => {
    const token = "A".repeat(32);
    expect(redact(`{"url":"/o/${token}/pay?x=1"}`)).toBe('{"url":"/o/[token]/pay?x=1"}');
    expect(redact('{"url":"/api/studio/shoots/3482697d-63ae-4174-a785-644cbde43950"}')).toContain("3482697d-63ae-4174-a785-644cbde43950");
  });

  it("reads the newest first, filters by level and text, and understands request lines", () => {
    const s = createLogStream(root, "t.log", null);
    s.write(line(30, "incoming request", { req: { method: "GET", url: "/api/studio/contacts" } }));
    s.write(line(30, "request completed", { req: { method: "GET", url: "/api/studio/contacts" }, res: { statusCode: 200 }, responseTime: 12.4 }));
    s.write(line(50, "Mail failed", { err: { message: "connection refused" } }));
    s.write("not json at all\n");
    s.write(line(30, "incoming request", { req: { method: "GET", url: "/assets/app-1.js" } }));
    s.write(line(30, "incoming request", { req: { method: "GET", url: "/api/studio/logs?level=info" } }));
    const all = readLog(root, { file: "t.log" }).entries;
    expect(all[0]!.message).toBe("not json at all");
    expect(all.map((e) => e.level)).toContain("error");
    expect(readLog(root, { file: "t.log", level: "error" }).entries.map((e) => e.message)).toEqual(["Mail failed"]);
    expect(readLog(root, { file: "t.log", q: "contacts" }).entries).toHaveLength(2);
    expect(all.some((e) => e.detail.includes("/assets/") || e.detail.includes("/logs"))).toBe(false);
    expect(parseLine(line(30, "request completed", { req: { method: "GET", url: "/x" }, res: { statusCode: 404 }, responseTime: 3 }))!.detail).toBe("GET /x  → 404  3 ms");
  });

  it("rotates at the size cap and keeps a few files", () => {
    const s = createLogStream(root, "r.log", null);
    const big = line(30, "x".repeat(900_000));
    for (let i = 0; i < 14; i++) s.write(big);
    expect(fs.existsSync(path.join(root, "r.log.1"))).toBe(true);
    expect(fs.existsSync(path.join(root, "r.log.3"))).toBe(false);
    expect(fs.statSync(path.join(root, "r.log")).size).toBeLessThan(6 * 1024 * 1024);
  });
});

describe("log routes", () => {
  it("are for the owner only and serve the file", async () => {
    const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
    fs.mkdirSync(config.galleriesDir, { recursive: true });
    const app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
    try {
      expect((await app.inject({ method: "GET", url: "/api/studio/logs" })).statusCode).toBe(401);
      const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "L", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
      const cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
      fs.mkdirSync(path.join(config.configDir, "logs"), { recursive: true });
      fs.writeFileSync(path.join(config.configDir, "logs", "openportrait.log"), line(40, "Disk almost full"));
      const list = await app.inject({ method: "GET", url: "/api/studio/logs?level=warn", headers: { cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().entries[0]).toMatchObject({ level: "warn", message: "Disk almost full" });
      const dl = await app.inject({ method: "GET", url: "/api/studio/logs/download", headers: { cookie } });
      expect(dl.headers["content-disposition"]).toMatch(/openportrait-log\.txt/);
      expect(dl.body).toContain("Disk almost full");
      expect((await app.inject({ method: "GET", url: "/api/studio/logs?level=loud", headers: { cookie } })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
