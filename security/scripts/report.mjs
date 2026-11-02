#!/usr/bin/env node
// Turns the machine-readable reports into one human-readable page: security/reports/SUMMARY.md
import fs from "node:fs";
import path from "node:path";
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "reports");
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const out = [];
const h = (t) => out.push(`\n## ${t}\n`);
out.push(`# Security run summary\n\nGenerated ${new Date().toISOString()}. Synthetic data, disposable containers.`);

const live = read("live-suite.json");
h("Live suite");
if (live) {
  const s = live.summary;
  out.push(`${s.pass} controls passed, ${s.open} findings still open, ${s.failed} failures, ${s.info} informational.\n`);
  out.push("| Status | ID | Check |\n|---|---|---|");
  for (const r of live.results) out.push(`| ${r.status} | ${r.id} | ${r.title}${r.note ? ` (${r.note})` : ""} |`);
} else out.push("_not run_");

const iso = read("isolation.json");
h("Deployment isolation");
if (iso) { out.push("| Status | ID | Check | Observed |\n|---|---|---|---|"); for (const r of iso.results) out.push(`| ${r.status} | ${r.id} | ${r.title} | ${r.observed} |`); } else out.push("_not run_");

const count = (t, sev, fixedOnly) => (t?.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []).filter((v) => v.Severity === sev && (!fixedOnly || v.FixedVersion)).length;
h("Dependencies and image (Trivy)");
for (const f of ["trivy-fs.json", "trivy-image.json"]) {
  const t = read(f);
  out.push(t ? `- **${f}**: ${count(t, "CRITICAL")} critical / ${count(t, "HIGH")} high (${count(t, "CRITICAL", true)} / ${count(t, "HIGH", true)} with a fix available)` : `- ${f}: _not run_`);
}
const sg = read("semgrep.json");
h("Static analysis (Semgrep)");
if (sg) { const by = {}; for (const r of sg.results) by[r.extra.severity] = (by[r.extra.severity] ?? 0) + 1; out.push(Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(", ") || "no findings"); } else out.push("_not run_");
const zap = read("zap.json");
h("Authenticated web scan (ZAP)");
if (zap) { out.push("| Risk | Alert | Instances |\n|---|---|---|"); for (const s of zap.site) for (const a of s.alerts) out.push(`| ${a.riskdesc} | ${a.name} | ${a.count} |`); } else out.push("_not run_");
fs.writeFileSync(path.join(dir, "SUMMARY.md"), out.join("\n") + "\n");
console.log(`wrote ${path.join(dir, "SUMMARY.md")}`);
