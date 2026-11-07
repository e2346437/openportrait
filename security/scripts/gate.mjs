#!/usr/bin/env node
// Release gate. Reads security/findings.json plus the reports in security/reports and decides whether a release may
// ship. Exit 0 = pass, 1 = blocked, 2 = could not evaluate (treated as blocked in enforce mode).
//
//   node security/scripts/gate.mjs            # report mode: prints the verdict, always exits 0 unless --enforce
//   node security/scripts/gate.mjs --enforce  # release builds: exit 1 when blocked
import fs from "node:fs";
import path from "node:path";

const enforce = process.argv.includes("--enforce");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const reports = path.join(root, "reports");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const blockers = [];
const warnings = [];
const today = new Date().toISOString().slice(0, 10);

// In enforce mode require evidence from every scanner the gate evaluates.
const evidence = [
  ["live-suite.json", "results"],
  ["isolation.json", "results"],
  ["trivy-fs.json", "Results"],
  ["trivy-image.json", "Results"],
  ["semgrep.json", "results"],
  ["zap.json", "site"],
];
if (enforce) {
  for (const [file, key] of evidence) {
    if (!Array.isArray(read(path.join(reports, file))?.[key])) {
      blockers.push(`missing or invalid security evidence: ${file}`);
    }
  }
  if (!Array.isArray(read(path.join(reports, "gitleaks.json")))) {
    blockers.push("missing or invalid security evidence: gitleaks.json");
  }
}

// 1. Confirmed Critical/High findings that are still open.
const registry = read(path.join(root, "findings.json"));
if (!Array.isArray(registry?.findings)) blockers.push("security/findings.json is missing or unreadable");
for (const f of registry?.findings ?? []) {
  if (f.status === "open" && f.confirmed && ["Critical", "High"].includes(f.severity)) blockers.push(`${f.id} (${f.severity}) is open: ${f.title}`);
  if (f.status === "open" && f.confirmed && f.severity === "Medium") warnings.push(`${f.id} (Medium) is open: ${f.title}`);
}

// 2. Live suite: any failed control, or an open finding that now passes (flip it to a control).
const live = read(path.join(reports, "live-suite.json"));
if (Array.isArray(live?.results)) {
  for (const r of live.results) if (r.status === "FAIL" || r.status === "FIXED-flip-to-control") blockers.push(`live test ${r.id}: ${r.status} - ${r.title}`);
} else warnings.push("no live-suite.json report (run security/scripts/run-local.sh)");
const iso = read(path.join(reports, "isolation.json"));
if (Array.isArray(iso?.results)) {
  for (const r of iso.results) if (r.status !== "pass") blockers.push(`isolation check ${r.id} failed: ${r.title}`);
} else warnings.push("no isolation.json report");

// 3. Secrets.
const leaks = read(path.join(reports, "gitleaks.json"));
const leakLog = fs.existsSync(path.join(reports, "gitleaks.log")) ? fs.readFileSync(path.join(reports, "gitleaks.log"), "utf8") : "";
if (Array.isArray(leaks) && leaks.length) blockers.push(`${leaks.length} secret(s) found by gitleaks`);
else if (!/no leaks found/.test(leakLog)) warnings.push("gitleaks did not report a clean run (check security/reports/gitleaks.log)");
const trivySecrets = ["trivy-fs.json", "trivy-image.json"].flatMap((f) => (read(path.join(reports, f))?.Results ?? []).flatMap((r) => r.Secrets ?? []));
if (trivySecrets.length) blockers.push(`${trivySecrets.length} secret(s) found by trivy`);

// 4. Vulnerabilities with a fix available, minus documented, unexpired exceptions.
const allow = read(path.join(root, "config", "allowlist.json"))?.exceptions ?? [];
const excepted = (id, pkg, where = "") =>
  allow.find((e) => (e.id === id || e.id === "*") && (!e.package || e.package === pkg) && (!e.path || where.includes(e.path)) && e.expires >= today);
for (const e of allow) if (e.expires < today) warnings.push(`exception for ${e.id} expired ${e.expires}: ${e.justification}`);
const vulnGroups = new Map();
for (const f of ["trivy-fs.json", "trivy-image.json"]) {
  const t = read(path.join(reports, f));
  if (!t) { warnings.push(`no ${f}`); continue; }
  for (const r of t.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      if (!["CRITICAL", "HIGH"].includes(v.Severity) || !v.FixedVersion) continue;
      if (excepted(v.VulnerabilityID, v.PkgName, r.Target)) continue;
      const key = `${f.replace(".json", "")}: ${r.Target}`;
      const g = vulnGroups.get(key) ?? [];
      g.push(`${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion} -> ${v.FixedVersion.split(",")[0]}`);
      vulnGroups.set(key, g);
    }
    for (const m of r.Misconfigurations ?? []) if (["CRITICAL", "HIGH"].includes(m.Severity) && !excepted(m.ID, undefined, r.Target)) blockers.push(`${m.Severity} ${m.ID}: ${m.Title} (${r.Target})`);
  }
}

for (const [key, list] of vulnGroups) blockers.push(`${list.length} HIGH/CRITICAL vulnerabilities with a fix available in ${key} (e.g. ${list.slice(0, 3).join("; ")})`);

// 5. Semgrep ERROR-level findings in application code.
const sg = read(path.join(reports, "semgrep.json"));
for (const r of sg?.results ?? []) if (r.extra.severity === "ERROR" && r.path.startsWith("apps/") && !excepted(r.check_id.split(".").pop(), undefined, r.path)) blockers.push(`semgrep ${r.check_id.split(".").pop()} at ${r.path}:${r.start.line}`);

// 6. ZAP: any High alert.
const zap = read(path.join(reports, "zap.json"));
for (const site of zap?.site ?? []) for (const a of site.alerts ?? []) if (Number(a.riskcode) >= 3) blockers.push(`ZAP high alert: ${a.name}`);

const unique = (xs) => [...new Set(xs)];
console.log(`Security release gate (${enforce ? "enforce" : "report"} mode)\n`);
for (const w of unique(warnings)) console.log(`  warn   ${w}`);
for (const b of unique(blockers)) console.log(`  BLOCK  ${b}`);
console.log(blockers.length ? `\nBLOCKED: ${unique(blockers).length} item(s) must be fixed or formally excepted (security/config/allowlist.json).` : "\nPASS: no release blockers.");
process.exit(blockers.length && enforce ? 1 : 0);

