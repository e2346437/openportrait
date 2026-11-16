import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * NET-4 (security/scripts/isolation.sh) must judge the OpenPortrait app process, not whichever node process is
 * listed first. These tests run the in-container helper against a fake /proc, so they are deterministic and need no Docker.
 */
const SCRIPT = path.resolve(import.meta.dirname, "../../../../security/scripts/app-process-check.sh");
const MAIN = "/app/apps/server/dist/main.js";
const CAPS_NONE = "0000000000000000";
const CAPS_PROFILE = "00000000000000c9"; // the four capabilities the container profile leaves in a root process's set

let proc: string;
beforeEach(() => { proc = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-")); });
afterEach(() => { fs.rmSync(proc, { recursive: true, force: true }); });

function addProcess(pid: number, o: { comm?: string; args: string[]; uid: number; caps: string }): void {
  const dir = path.join(proc, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "comm"), `${o.comm ?? "node"}\n`);
  fs.writeFileSync(path.join(dir, "cmdline"), `${o.args.join("\0")}\0`);
  fs.writeFileSync(path.join(dir, "status"), `Name:\t${o.comm ?? "node"}\nUid:\t${o.uid}\t${o.uid}\t${o.uid}\t${o.uid}\nCapEff:\t${o.caps}\n`);
}
const app = (pid: number, over: { uid?: number; caps?: string } = {}) => addProcess(pid, { args: ["node", MAIN], uid: over.uid ?? 1000, caps: over.caps ?? CAPS_NONE });
const probe = (pid: number) => addProcess(pid, { args: ["node", "-e", "fetch('http://127.0.0.1:8080/api/health')"], uid: 0, caps: CAPS_PROFILE });
const run = () => execFileSync("sh", [SCRIPT], { env: { ...process.env, PROC_ROOT: proc, APP_MAIN: MAIN }, encoding: "utf8" }).trim();

describe("NET-4 app process selection", () => {
  it("passes for an unprivileged app even when a root health probe is listed first", () => {
    probe(10); // lexicographically before 9, and a root process with capabilities: the old check picked this
    app(9);
    expect(run()).toMatch(/^BLOCKED /);
    expect(run()).toContain("pid=9");
  });

  it("passes for the app alone", () => {
    app(7);
    expect(run()).toMatch(/^BLOCKED uid=1000\/1000\/1000\/1000 caps=0+ pid=7 /);
  });

  it("fails when the app runs as root, and says which process", () => {
    probe(10);
    app(9, { uid: 0 });
    const out = run();
    expect(out).toMatch(/^REACHED /);
    expect(out).toContain("pid=9");
    expect(out).toContain(MAIN);
  });

  it("fails when the app holds a capability", () => {
    app(9, { caps: CAPS_PROFILE });
    expect(run()).toMatch(/^REACHED .*caps=00000000000000c9 pid=9/);
  });

  it("fails when only some of the uids are root", () => {
    addProcess(9, { args: ["node", MAIN], uid: 1000, caps: CAPS_NONE });
    fs.writeFileSync(path.join(proc, "9", "status"), `Uid:\t1000\t0\t1000\t1000\nCapEff:\t${CAPS_NONE}\n`);
    expect(run()).toMatch(/^REACHED /);
  });

  it("fails, naming what it did find, when there is no app process (only a probe)", () => {
    probe(10);
    const out = run();
    expect(out).toMatch(/^REACHED no app process found/);
    expect(out).toContain("pid=10");
  });

  it("fails when there is no node process at all", () => {
    expect(run()).toMatch(/^REACHED no app process found.*none/);
  });

  it("fails when two processes look like the app, rather than guessing", () => {
    app(9);
    app(11, { uid: 0 });
    expect(run()).toMatch(/^REACHED ambiguous: 2 app processes/);
  });

  it("does not treat a non-node process, or a node running something else, as the app", () => {
    addProcess(5, { comm: "sh", args: ["sh", MAIN], uid: 0, caps: CAPS_PROFILE });
    addProcess(6, { args: ["node", "/app/other.js"], uid: 0, caps: CAPS_PROFILE });
    app(9);
    expect(run()).toMatch(/^BLOCKED .* pid=9 /);
  });

  it("is what isolation.sh runs for NET-4, and keeps the result as a failure unless it says BLOCKED", () => {
    const iso = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../security/scripts/isolation.sh"), "utf8");
    const line = iso.split("\n").find((l) => l.startsWith("check NET-4"));
    expect(line).toContain("app-process-check.sh");
    expect(line).toContain("BLOCKED");
  });
});
