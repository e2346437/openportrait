import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The release gate (security/scripts/gate.mjs) suppresses a scanner finding when an unexpired entry in
 * security/config/allowlist.json matches it. A malformed entry fails quietly: a missing or misspelled expiry is simply
 * ignored, and an entry whose id is "*" with no package or path would match every finding. These checks keep the file
 * honest without touching the gate.
 */
type Exception = { id?: string; package?: string; path?: string; justification?: string; expires?: string };
const file = path.resolve(__dirname, "../../../../security/config/allowlist.json");
const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { exceptions?: Exception[] };
const exceptions = doc.exceptions ?? [];
const label = (e: Exception) => `${e.id}${e.package ? ` / ${e.package}` : ""}${e.path ? ` @ ${e.path}` : ""}`;
const DAY = 86_400_000;

describe("security allowlist hygiene", () => {
  it("is a list of exceptions", () => {
    expect(Array.isArray(doc.exceptions)).toBe(true);
  });
  it("gives every exception an id and a real justification", () => {
    for (const e of exceptions) {
      expect(e.id, label(e)).toBeTruthy();
      expect((e.justification ?? "").trim().length, `justification for ${label(e)}`).toBeGreaterThanOrEqual(40);
    }
  });
  it("gives every exception a valid calendar expiry no more than 13 months out", () => {
    for (const e of exceptions) {
      expect(e.expires, `expiry for ${label(e)}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const at = new Date(`${e.expires}T00:00:00Z`);
      expect(at.toISOString().slice(0, 10), `${label(e)} is a real date`).toBe(e.expires);
      expect(at.getTime() - Date.now(), `${label(e)} expires within 13 months`).toBeLessThan(400 * DAY);
    }
  });
  it("never lets a wildcard id match every finding", () => {
    for (const e of exceptions.filter((x) => x.id === "*")) expect(Boolean(e.package || e.path), `${label(e)} must name a package or path`).toBe(true);
  });
  it("has no duplicate entries", () => {
    const keys = exceptions.map((e) => `${e.id}|${e.package ?? ""}|${e.path ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
