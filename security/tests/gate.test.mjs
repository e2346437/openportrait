import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const reports = {
  "live-suite.json": { results: [{ status: "PASS" }] },
  "isolation.json": { results: [{ status: "pass" }] },
  "trivy-fs.json": { Results: [] },
  "trivy-image.json": { Results: [] },
  "semgrep.json": { results: [] },
  "zap.json": { site: [] },
  "gitleaks.json": [],
};

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "reports"]) fs.mkdirSync(path.join(root, dir));
  const gate = path.join(root, "scripts", "gate.mjs");
  fs.copyFileSync(new URL("../scripts/gate.mjs", import.meta.url), gate);
  fs.writeFileSync(path.join(root, "findings.json"), '{"findings":[]}');
  for (const [file, content] of Object.entries({ ...reports, ...overrides })) {
    if (content !== undefined) fs.writeFileSync(path.join(root, "reports", file), JSON.stringify(content));
  }
  return (...args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8" });
}

test("complete clean evidence passes enforcement", (t) => {
  const result = fixture(t)("--enforce");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS/);
});

test("missing or malformed evidence fails enforcement", (t) => {
  const run = fixture(t, { "semgrep.json": undefined, "trivy-image.json": {} });
  const result = run("--enforce");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /missing or invalid security evidence: semgrep\.json/);
  assert.match(result.stdout, /missing or invalid security evidence: trivy-image\.json/);
  assert.equal(run().status, 0);
});

test("scanner findings still block with complete evidence", (t) => {
  const result = fixture(t, { "gitleaks.json": [{}] })("--enforce");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /secret\(s\) found by gitleaks/);
});
