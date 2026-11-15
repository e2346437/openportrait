#!/usr/bin/env node
// V1 source inventory; static declarations only. Run: node scripts/v1-parity-inventory.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "apps/server/src");
const ui = path.join(root, "apps/web/src/App.tsx");
const output = path.join(root, "docs/v1-parity-inventory.json");
const read = (p) => fs.readFileSync(p, "utf8");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
}).sort();
const rel = (p) => path.relative(root, p).replaceAll(path.sep, "/");
const app = read(path.join(server, "app.ts"));
const prefixes = new Map();
for (const match of app.matchAll(/app\.register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*["'`]([^"'`]+)["'`]/g)) {
  prefixes.set(match[1], match[2]);
}
const operations = [];
const warnings = [];
for (const file of walk(path.join(server, "routes"))) {
  const source = read(file);
  const exported = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const registered = exported.filter((n) => prefixes.has(n));
  const prefix = registered.length === 1 ? prefixes.get(registered[0]) : null;
  const isAbsolute = exported.includes("brandingRoutes");
  const galleryPrefix = exported.includes("galleryRoutes") ? prefixes.get("galleryRoutes") : null;
  let activeExport = null;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fn = lines[i].match(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/);
    if (fn) activeExport = fn[1];
    // Supports app.get<FastifyType>(...) and app.get(...). It does not parse aliases or app.route.
    const match = lines[i].match(/\bapp\.(get|post|put|patch|delete|head|options)\s*(?:<.*?>)?\s*\(\s*["'`]([^"'`]+)["'`]/);
    if (!match) continue;
    const local = match[2];
    const effectivePrefix = prefixes.get(activeExport) ?? prefix ?? galleryPrefix;
    const full = isAbsolute ? local : effectivePrefix === null || effectivePrefix === undefined ? null : effectivePrefix.replace(/\/$/, "") + (local.startsWith("/") ? local : "/" + local);
    operations.push({ id: "HTTP:" + rel(file) + ":" + (i + 1), method: match[1].toUpperCase(), local_path: local, full_path: full, source: rel(file), line: i + 1, source_sha256: sha(source), prefix_status: full === null ? "unresolved" : "resolved", status: "source-declared-unverified" });
  }
  if (source.includes("app.route(")) warnings.push(rel(file) + ": app.route requires separate inspection");
}
const uiSource = read(ui);
const uiRoutes = [];
uiSource.split("\n").forEach((line, i) => {
  const m = line.match(/<Route\s+path="([^"]+)"/);
  if (m) uiRoutes.push({ id: "UI:" + (i + 1), declared_path: m[1], source: rel(ui), line: i + 1, source_sha256: sha(uiSource), status: "source-declared-unverified", note: "Nested route path may be relative" });
});
operations.sort((a,b)=>a.source.localeCompare(b.source)||a.line-b.line);
const inventory = { schema_version: "0.1.0", generated_by: "scripts/v1-parity-inventory.mjs", limitations: ["Static declarations only; no runtime tests", "Unresolved prefixes, dynamic routes, Pro extension routes, and actions inside screens require manual review", "Line-based IDs change when source is reordered"], counts: { http: operations.length, ui: uiRoutes.length, resolved_http: operations.filter(x=>x.full_path !== null).length }, warnings, http: operations, ui: uiRoutes };
if (process.argv.includes("--check")) {
  // A baseline floor catches accidental mass omission; a committed snapshot is checked separately when present.
  const failures = [];
  if (operations.length !== 319) failures.push("HTTP inventory count drifted from reviewed 319 declarations");
  if (uiRoutes.length !== 59) failures.push("UI inventory count drifted from reviewed 59 routes");
  const unresolved = operations.filter(x=>x.full_path === null);
  if (unresolved.length !== 0) failures.push("Unresolved route prefixes: " + unresolved.length);
  const keys = new Set(operations.map(x=>x.method+" "+x.full_path));
  for (const expected of ["POST /api/studio/auth/login","POST /api/studio/orders/:id/refunds","POST /api/public/contract/:token/sign","POST /api/public/order/:token/pay","POST /api/studio/backups/restore/confirm"]) {
    if (!keys.has(expected)) failures.push("Missing high-risk route: "+expected);
  }
  if (fs.existsSync(output)) {
    const previous = JSON.parse(read(output));
    if (JSON.stringify(previous) !== JSON.stringify(inventory)) failures.push("Inventory drift: run node scripts/v1-parity-inventory.mjs and commit updated docs/v1-parity-inventory.json");
  }
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.log("V1 parity inventory checks passed:", inventory.counts);
} else {
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, JSON.stringify(inventory,null,2)+"\n");
  console.log("Wrote", rel(output), inventory.counts, "warnings:", warnings.length);
}
