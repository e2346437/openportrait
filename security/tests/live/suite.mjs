#!/usr/bin/env node
// Black-box security suite. Runs against disposable containers started by scripts/run-local.sh (or the CI job),
// with synthetic data only. It refuses to run against anything that is not a loopback or private address.
//
//   OP_A_URL=http://127.0.0.1:18080 OP_B_URL=http://127.0.0.1:18081 \
//   OP_A_GALLERIES=/path/to/a/galleries OP_A_SFTP_PORT=12222 node security/tests/live/suite.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Client, control, finish, info, openFinding, sleep } from "./lib.mjs";

const A_URL = process.env.OP_A_URL ?? "http://127.0.0.1:18080";
const B_URL = process.env.OP_B_URL ?? "http://127.0.0.1:18081";
const GALLERIES = process.env.OP_A_GALLERIES;
const SFTP_PORT = Number(process.env.OP_A_SFTP_PORT ?? 0);
const REPORT = process.env.OP_REPORT ?? "";

for (const u of [A_URL, B_URL]) {
  const host = new URL(u).hostname;
  if (!/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) && process.env.OP_ALLOW_REMOTE !== "1") {
    console.error(`Refusing to test ${u}: only loopback/private addresses are allowed. This suite sends hostile input.`);
    process.exit(2);
  }
}

const require = createRequire(path.resolve("apps/server/package.json"));
const PW_A = "synthetic-Pass-12345";
const PW_B = "synthetic-Pass-67890";
const a = new Client(A_URL);
const b = new Client(B_URL);
const anon = new Client(A_URL);

// ---------- SEC-002: a brand-new install can be claimed by whoever reaches it first ----------
await openFinding("SEC-002", "first-run setup needs proof the caller is the person who started the container", async () => {
  const probe = new Client(A_URL);
  const r = await probe.post("/api/studio/setup", { studioName: "Audit Studio A", ownerName: "Owner A", email: "owner-a@audit.invalid", password: PW_A, timezone: "UTC" });
  // Secure behaviour: an anonymous caller is refused (for example, a setup code printed in the container log is required).
  if (r.status === 200) {
    a.cookie = probe.cookie;
    return false;
  }
  return true;
});
if (!a.cookie) {
  const l = await a.post("/api/studio/auth/login", { email: "owner-a@audit.invalid", password: PW_A });
  if (l.status !== 200) throw new Error("could not sign in to deployment A; is it a fresh container?");
}
const setupB = await b.post("/api/studio/setup", { studioName: "Audit Studio B", ownerName: "Owner B", email: "owner-b@audit.invalid", password: PW_B, timezone: "UTC" });
if (setupB.status !== 200) await b.post("/api/studio/auth/login", { email: "owner-b@audit.invalid", password: PW_B });

// ---------- SEC-001: rate limiting ----------
await openFinding("SEC-001", "login is throttled per real client even when CF-Connecting-IP is forged on every request", async () => {
  let throttled = false;
  for (let i = 0; i < 30; i++) {
    const r = await anon.req("POST", "/api/studio/auth/login", { json: { email: "owner-a@audit.invalid", password: `wrong-${i}` }, headers: { "cf-connecting-ip": `10.77.${i}.9` } });
    if (r.status === 429) throttled = true;
  }
  return throttled;
});
await sleep(1000);

// ---------- headers ----------
await openFinding("SEC-009", "responses carry Content-Security-Policy", async () => !!(await anon.get("/studio")).headers.get("content-security-policy"));
await control("HDR-1", "nosniff, frame and referrer headers are present", async () => {
  const h = (await anon.get("/api/health")).headers;
  return h.get("x-content-type-options") === "nosniff" && !!h.get("x-frame-options") && !!h.get("referrer-policy");
});
await control("ERR-1", "errors don't leak stack traces or file paths", async () => {
  const r = await anon.req("POST", "/api/studio/auth/login", { body: "{bad", headers: { "content-type": "application/json" } });
  const t = JSON.stringify(r.body);
  return r.status === 400 && !/\bat \w+.*\.(ts|js):\d+|\/app\/|node_modules/.test(t);
});

// ---------- gallery: media URLs, link strength, throttling, EXIF ----------
let slug = null;
let galleryId = null;
let photo = null;
if (GALLERIES) {
  const sharp = require("sharp");
  const dir = path.join(GALLERIES, "2026", "2026-11-14 Family - Audit Smith");
  fs.mkdirSync(dir, { recursive: true });
  const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 90, b: 60 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "AuditCam", Model: "SYNTH-1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 44/1 55/1", GPSLongitudeRef: "W", GPSLongitude: "73/1 59/1 11/1" } })
    .toBuffer();
  fs.writeFileSync(path.join(dir, "IMG_0001.jpg"), img);
  fs.writeFileSync(path.join(dir, "IMG_0002.jpg"), img);
  try {
    fs.chmodSync(dir, 0o777);
    for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o666);
  } catch {}
  await a.post("/api/studio/ingest/rescan", {});
  let folderId = null;
  for (let i = 0; i < 40 && !folderId; i++) {
    await sleep(1500);
    const f = await a.get("/api/studio/ingest/folders");
    folderId = f.body.folders?.[0]?.id ?? null;
    if (folderId) {
      const g = await a.post(`/api/studio/ingest/folders/${folderId}/gallery`, {});
      if (g.status === 200) galleryId = g.body.galleryId;
      else folderId = null;
    }
  }
  if (galleryId) {
    for (let i = 0; i < 30; i++) {
      const g = await a.get(`/api/studio/galleries/${galleryId}`);
      if (g.body.photos?.filter((p) => p.state === "ready").length >= 2) break;
      await sleep(1000);
    }
    await a.post(`/api/studio/galleries/${galleryId}/publish`, { downloadLock: "none", downloadSize: "full" });
    slug = (await a.get("/api/studio/galleries")).body.galleries.find((g) => g.id === galleryId)?.slug;
  }
}

if (slug) {
  const pub = new Client(A_URL);
  const view = (await pub.get(`/api/g/${slug}`)).body;
  photo = view.photos?.[0];

  await control("GAL-1", "an anonymous visitor with the link sees the gallery; the same request for a made-up link is 404", async () => photo && (await pub.get("/api/g/not-a-real-link-0000")).status === 404);
  await control("GAL-2", "a media URL with a tampered or missing signature is refused", async () => {
    const [p, s] = photo.thumb.split("?s=");
    const tampered = `${p}?s=${s.slice(0, -2)}AA`;
    return (await pub.get(p)).status === 404 && (await pub.get(tampered)).status === 404 && (await pub.get(`${p.replace(photo.id, "AAAAAAAAAAAA")}?s=${s}`)).status === 404;
  });
  await control("GAL-3", "a download needs an identified visitor (email) when downloads are on", async () => (await pub.get(`/api/g/${slug}/photos/${photo.id}/download`)).status === 401);
  await control("GAL-4", "filename traversal in a staff upload is flattened to a basename inside the gallery folder", async () => {
    const data = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300090002f9f1e3c40000000049454e44ae426082", "hex");
    const s = await a.post("/api/studio/uploads/", { galleryId, set: "", filename: "a/../../evil.jpg", size: data.length, lastModified: 0 });
    if (s.status !== 200) return s.status >= 400;
    const p = await a.req("PATCH", `/api/studio/uploads/${s.body.id}`, { body: data, headers: { "content-type": "application/offset+octet-stream", "upload-offset": "0" } });
    return p.status === 200 && p.body.filename === "evil.jpg" && !fs.existsSync(path.join(GALLERIES, "2026", "evil.jpg")) && !fs.existsSync(path.join(GALLERIES, "evil.jpg"));
  });
  await control("GAL-5", "a non-image extension is refused for photo upload", async () => (await a.post("/api/studio/uploads/", { galleryId, set: "", filename: "shell.php", size: 10, lastModified: 0 })).status === 415);

  await openFinding("SEC-004", "after a gallery is unpublished, its photo URLs stop working", async () => {
    const before = (await pub.get(photo.thumb)).status;
    await a.post(`/api/studio/galleries/${galleryId}/unpublish`, {});
    const gallery = (await pub.get(`/api/g/${slug}`)).status;
    const after = (await pub.get(photo.thumb)).status;
    await a.post(`/api/studio/galleries/${galleryId}/publish`, { downloadLock: "none", downloadSize: "full" });
    return before === 200 && gallery === 404 && after === 404;
  });

  await openFinding("SEC-005", "public gallery endpoints are rate limited per visitor", async () => {
    let limited = false;
    for (let i = 0; i < 150 && !limited; i++) limited = (await pub.get(`/api/g/${slug}`)).status === 429;
    return limited;
  });

  const v = new Client(A_URL);
  await v.post(`/api/g/${slug}/identify`, { email: "victim@audit.invalid" });
  await openFinding("SEC-012", "a visitor can't act as an email address they haven't proven they own", async () => {
    // Identify accepts any address. Secure behaviour would be to confirm ownership before showing or changing that address's favorites.
    const other = new Client(A_URL);
    const r = await other.post(`/api/g/${slug}/identify`, { email: "victim@audit.invalid" });
    return r.status !== 200;
  });
  await info("SEC-013", "full-size downloads keep GPS in the file", async () => {
    const r = await v.req("GET", `/api/g/${slug}/photos/${photo.id}/download`, { raw: true });
    const buf = Buffer.from(await r.arrayBuffer());
    const exifr = require("exifr");
    const gps = await exifr.gps(buf).catch(() => null);
    return gps ? `GPS present (${gps.latitude.toFixed(2)}, ${gps.longitude.toFixed(2)})` : false;
  });

  // password gate
  await a.patch(`/api/studio/galleries/${galleryId}`, { accessMode: "password", password: "abcd" });
  const gated = new Client(A_URL);
  await control("GAL-6", "a password-protected gallery sends no photo data before the password", async () => {
    const r = (await gated.get(`/api/g/${slug}`)).body;
    return !!r.gate?.password && r.photos.length === 0 && r.sets.length === 0 && r.gallery.cover === null;
  });
  await control("GAL-7", "the password gate also blocks downloads and zips", async () => {
    await gated.post(`/api/g/${slug}/identify`, { email: "x@audit.invalid" });
    return (await gated.get(`/api/g/${slug}/downloads`)).status === 401 && (await gated.get(`/api/g/${slug}/zip?scope=gallery`)).status === 401 && (await gated.get(`/api/g/${slug}/photos/${photo.id}/download`)).status === 401;
  });
  await a.patch(`/api/studio/galleries/${galleryId}`, { accessMode: "link" });
}

// ---------- MCP and OAuth ----------
await a.put("/api/studio/ai", { enabled: true });
const tok = (await a.post("/api/studio/ai/connections", { label: "live-read", level: "read", areas: ["studio"] })).body.token;
const rpc = (t, method, params) => fetch(`${A_URL}/mcp`, { method: "POST", headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
await control("MCP-L1", "no token is refused; a read token cannot call a write tool", async () => {
  const none = await rpc(null, "tools/list");
  const r = await (await rpc(tok, "tools/call", { name: "leads_create", arguments: { contact: { firstName: "x" } } })).json();
  return none.status === 401 && (r.result?.isError || r.error);
});
await openFinding("SEC-011", "the MCP endpoint rejects a foreign Origin header", async () => {
  const r = await fetch(`${A_URL}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, origin: "https://evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  return r.status === 403;
});
await openFinding("SEC-010", "OAuth metadata is not built from the Host header", async () => {
  const r = await fetch(`${A_URL}/.well-known/oauth-authorization-server`, { headers: { host: "evil.example" } }).catch(() => null);
  // Node's fetch won't override Host; fall back to the raw socket.
  const net = await import("node:net");
  const body = await new Promise((res) => {
    const s = net.connect(new URL(A_URL).port, new URL(A_URL).hostname, () => s.write("GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"));
    let d = "";
    s.on("data", (c) => (d += c));
    s.on("end", () => res(d));
    s.on("error", () => res(""));
  });
  void r;
  return !body.includes("evil.example");
});
await control("OAUTH-1", "authorization requires PKCE S256, exact redirect match, a one-use code and a verified verifier", async () => {
  const reg = await (await fetch(`${A_URL}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "audit", redirect_uris: ["https://app.invalid/cb"] }) })).json();
  const cid = reg.client_id;
  const noPkce = await fetch(`${A_URL}/oauth/authorize?client_id=${cid}&redirect_uri=https://app.invalid/cb&response_type=code`, { redirect: "manual" });
  const badRedirect = await fetch(`${A_URL}/oauth/authorize?client_id=${cid}&redirect_uri=https://evil.invalid/x&response_type=code&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`, { redirect: "manual" });
  const crypto = await import("node:crypto");
  const verifier = crypto.randomBytes(48).toString("base64url").slice(0, 64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const dec = await a.post("/api/studio/oauth/decision", { client_id: cid, redirect_uri: "https://app.invalid/cb", code_challenge: challenge, approve: true, level: "read", areas: ["studio"] });
  const code = new URL(dec.body.redirectTo).searchParams.get("code");
  const form = (o) => fetch(`${A_URL}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
  const wrong = await form({ grant_type: "authorization_code", client_id: cid, code, code_verifier: "b".repeat(50), redirect_uri: "https://app.invalid/cb" });
  const reuse = await form({ grant_type: "authorization_code", client_id: cid, code, code_verifier: verifier, redirect_uri: "https://app.invalid/cb" });
  const loc = noPkce.headers.get("location") ?? "";
  return loc.includes("error=invalid_request") && badRedirect.status === 400 && wrong.status === 400 && reuse.status === 400;
});

// ---------- camera upload server ----------
if (SFTP_PORT) {
  const { Client: Ssh } = require("ssh2");
  const cam = await a.post("/api/studio/upload/accounts", { label: "Audit Cam" });
  await a.post("/api/studio/upload/open", { minutes: 30 });
  await sleep(1500);
  const connect = (user, password) =>
    new Promise((res, rej) => {
      const c = new Ssh();
      const t = setTimeout(() => rej(new Error("timeout")), 6000);
      c.on("ready", () => (clearTimeout(t), res(c))).on("error", (e) => (clearTimeout(t), rej(e))).connect({ host: new URL(A_URL).hostname, port: SFTP_PORT, username: user, password, readyTimeout: 5000 });
    });
  const c = await connect(cam.body.username, cam.body.password);
  const s = await new Promise((res, rej) => c.sftp((e, x) => (e ? rej(e) : res(x))));
  const call = (fn, ...args) => new Promise((res) => fn.call(s, ...args, (e, r) => res({ e: e && e.message, r })));
  const put = (name, data) => new Promise((res) => { const w = s.createWriteStream(name); w.on("close", () => res("ok")); w.on("error", (e) => res("ERR " + e.message)); w.end(data); });
  await put("/d/good.jpg", "ORIGINAL");
  await put("/d/junk.jpg", "JUNK");
  await control("SFTP-1", "a camera login cannot read, list parents of, or delete files", async () => (await call(s.readFile, "/d/good.jpg")).e && (await call(s.unlink, "/d/good.jpg")).e);
  await control("SFTP-2", "path traversal stays inside the camera's own folder", async () => {
    await put("/../../escape.txt", "x");
    const root = process.env.OP_A_INCOMING;
    if (!root) return "skipped: OP_A_INCOMING not set";
    const stray = [];
    const walk = (d, depth = 0) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.name === "escape.txt" && !f.includes("Audit Cam")) stray.push(f); if (e.isDirectory() && depth < 4) walk(f, depth + 1); } };
    walk(root);
    return stray.length === 0;
  });
  await openFinding("SEC-007", "a camera login cannot replace a photo already in its folder (rename or re-upload)", async () => {
    await call(s.rename, "/d/junk.jpg", "/d/good.jpg");
    const again = await put("/d/good.jpg", "OVERWRITTEN");
    const root = process.env.OP_A_INCOMING;
    if (!root) return again !== "ok";
    const f = path.join(root, "Audit Cam", "d", "good.jpg");
    return fs.existsSync(f) && fs.readFileSync(f, "utf8") === "ORIGINAL";
  });
  c.end();
}

// ---------- two-deployment isolation (application layer) ----------
await control("ISO-L1", "different instance ids; A's session cookie, MCP token and media signature mean nothing on B", async () => {
  const ia = (await a.get("/api/health")).body.instanceId;
  const ib = (await b.get("/api/health")).body.instanceId;
  const me = await new Client(B_URL);
  me.cookie = a.cookie;
  const meRes = await me.get("/api/studio/auth/me");
  await b.put("/api/studio/ai", { enabled: true });
  const r = await fetch(`${B_URL}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const media = photo ? await fetch(`${B_URL}${photo.thumb}`) : { status: 404 };
  return ia !== ib && meRes.body.user === null && r.status === 401 && media.status === 404;
});

finish(REPORT || null);
