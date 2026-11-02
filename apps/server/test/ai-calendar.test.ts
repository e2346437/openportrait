import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let cookie: string;
let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-aicrm-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "T", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const staff = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return r.json();
};
const rpc = (token: string, name: string, args: object = {}) =>
  app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` } });
const out = (res: { json(): { result: { content: Array<{ text: string }>; isError?: boolean } } }) => {
  const text = res.json().result.content[0]!.text;
  let data: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = JSON.parse(text);
  } catch {
    /* an error message is plain text */
  }
  return { data, error: !!res.json().result.isError };
};

async function token(level: "read" | "assist", areas: string[]) {
  await staff("PUT", "/ai/", { enabled: true });
  return (await staff("POST", "/ai/connections", { label: "Test AI", level, areas })).token as string;
}

describe("MCP tools for calendar and booking pages", () => {
  it("finds free time around a shoot and lists booking pages", async () => {
    const t = await token("assist", ["shoots", "calendar"]);
    const c = await staff("POST", "/contacts", { firstName: "Dana", lastName: "Reyes", email: "dana@example.com" });
    const typeId = (await staff("GET", "/shoot-types")).types[0].id;
    const start = Date.UTC(2027, 2, 5, 15);
    await staff("POST", "/shoots", { primaryContactId: c.id, shootTypeId: typeId, events: [{ startsAt: start, endsAt: start + 3_600_000 }] });
    const free = out(await rpc(t, "calendar_find_free_time", { from: start - 3_600_000, to: start + 7_200_000, minutes: 60 }));
    expect(free.data).toEqual([
      { startsAt: start - 3_600_000, endsAt: start },
      { startsAt: start + 3_600_000, endsAt: start + 7_200_000 },
    ]);
    expect(out(await rpc(t, "shoots_list_types")).error).toBe(false);
    await staff("POST", "/schedulers", { name: "Consult", durationMinutes: 30, availability: { "1": [{ start: "09:00", end: "12:00" }] } });
    const pages = out(await rpc(t, "calendar_list_schedulers")).data;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ name: "Consult", slug: "consult" });
  });
});
