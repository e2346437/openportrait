// Tiny test runner + HTTP helpers for the live (black-box) suite. No dependencies beyond Node 22.
export const results = [];
const STRICT = process.env.SECURITY_STRICT === "1";

/** A control: tested, held. Fails the run if it stops holding. */
export async function control(id, title, fn) {
  return record(id, title, "control", fn, true);
}
/** An open finding: asserts the SECURE behaviour. "open" while it fails; the run fails if it unexpectedly passes (flip it to control). */
export async function openFinding(id, title, fn) {
  return record(id, title, "open", fn, false);
}
/** Informational check: recorded, never fails the run. */
export async function info(id, title, fn) {
  return record(id, title, "info", fn, null);
}

async function record(id, title, kind, fn, expectPass) {
  let passed = false;
  let note = "";
  try {
    const r = await fn();
    passed = r !== false;
    if (typeof r === "string") note = r;
  } catch (e) {
    note = String(e?.message ?? e).slice(0, 300);
  }
  let status;
  if (kind === "info") status = passed ? "info" : "info";
  else if (kind === "control") status = passed ? "pass" : "FAIL";
  else status = passed ? (STRICT ? "pass" : "FIXED-flip-to-control") : STRICT ? "FAIL" : "open";
  results.push({ id, title, kind, status, note });
  console.log(`${status.padEnd(22)} ${id.padEnd(10)} ${title}${note ? `  [${note}]` : ""}`);
  return passed;
}

export function finish(file) {
  const bad = results.filter((r) => r.status === "FAIL" || r.status === "FIXED-flip-to-control");
  const summary = { total: results.length, pass: results.filter((r) => r.status === "pass").length, open: results.filter((r) => r.status === "open").length, info: results.filter((r) => r.status === "info").length, failed: bad.length };
  if (file) {
    import("node:fs").then((fs) => fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2)));
  }
  console.log(`\n${JSON.stringify(summary)}`);
  process.exitCode = bad.length ? 1 : 0;
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = "";
  }
  async req(method, path, { json, body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload = body;
    if (json !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(json);
    }
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect: "manual" });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) {
      const [pair] = c.split(";");
      if (pair.startsWith("op_session=")) this.cookie = pair;
    }
    if (raw) return res;
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  get = (p, o) => this.req("GET", p, o);
  post = (p, json, o) => this.req("POST", p, { json, ...o });
  put = (p, json, o) => this.req("PUT", p, { json, ...o });
  patch = (p, json, o) => this.req("PATCH", p, { json, ...o });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
