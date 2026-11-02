import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Client as SshClient } from "ssh2";
import { Client as FtpClient } from "basic-ftp";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { cleanVirtual, jailPath, landingVirtual, sweepStaleUploads } from "../src/upload/files.js";
import { generatePassword, normalizePublicKey, usernameFromLabel } from "../src/upload/accounts.js";
import { loadHostKey } from "../src/upload/sftp.js";
import { isRoutineDisconnect } from "../src/upload/ftp.js";
import { scheduleProblem, scheduleState } from "../src/upload/schedule.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

describe("schedule", () => {
  const evenings = [{ days: [1, 2, 3, 4, 5], start: "18:00", end: "22:00" }];
  it("is open inside a window and reports when it closes", () => {
    const now = Date.parse("2026-11-03T19:00:00Z"); // Tuesday
    const s = scheduleState(evenings, "UTC", now);
    expect(s.open).toBe(true);
    expect(s.closesAt).toBe(Date.parse("2026-11-03T22:00:00Z"));
    expect(s.nextOpenAt).toBe(Date.parse("2026-11-04T18:00:00Z"));
  });
  it("reports the next opening when closed, skipping the weekend", () => {
    const s = scheduleState(evenings, "UTC", Date.parse("2026-11-06T23:00:00Z")); // Friday night
    expect(s.open).toBe(false);
    expect(s.nextOpenAt).toBe(Date.parse("2026-11-09T18:00:00Z"));
  });
  it("handles a window that runs past midnight", () => {
    const night = [{ days: [5], start: "22:00", end: "02:00" }];
    expect(scheduleState(night, "UTC", Date.parse("2026-11-07T01:00:00Z")).open).toBe(true); // Saturday 01:00
    expect(scheduleState(night, "UTC", Date.parse("2026-11-07T03:00:00Z")).open).toBe(false);
  });
  it("uses the studio's time zone", () => {
    const s = scheduleState(evenings, "America/New_York", Date.parse("2026-11-03T23:30:00Z")); // 18:30 in New York
    expect(s.open).toBe(true);
  });
  it("rejects unusable windows", () => {
    expect(scheduleProblem([{ days: [], start: "09:00", end: "10:00" }])).toMatch(/day/);
    expect(scheduleProblem([{ days: [1], start: "9:00", end: "10:00" }])).toMatch(/18:00/);
    expect(scheduleProblem([{ days: [1], start: "09:00", end: "09:00" }])).toMatch(/same/);
    expect(scheduleProblem(evenings)).toBeNull();
  });
});

describe("SSH host key", () => {
  it("is always one the server can read back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-hostkey-"));
    try {
      for (let i = 0; i < 150; i++) {
        const d = path.join(dir, String(i));
        fs.mkdirSync(d);
        expect(loadHostKey(d).fingerprint).toMatch(/^SHA256:/);
      }
      // The same key (and fingerprint) comes back on the next start.
      expect(loadHostKey(path.join(dir, "0")).fingerprint).toBe(loadHostKey(path.join(dir, "0")).fingerprint);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("camera disconnects", () => {
  it("treats a camera dropping its Wi-Fi as normal, not as an error", () => {
    expect(isRoutineDisconnect(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRoutineDisconnect(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isRoutineDisconnect(new Error("Premature close"))).toBe(false);
    expect(isRoutineDisconnect(new Error("EACCES: permission denied, open '/incoming/x'"))).toBe(false);
    expect(isRoutineDisconnect(undefined)).toBe(false);
  });
});

describe("camera logins", () => {
  it("makes passwords that are easy to type on a camera", () => {
    for (let i = 0; i < 50; i++) expect(generatePassword()).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
    expect(generatePassword()).not.toBe(generatePassword());
  });
  it("derives a login name from the camera name", () => {
    expect(usernameFromLabel("Nikon Z9")).toBe("nikon-z9");
    expect(usernameFromLabel("  ")).toBe("camera");
  });
  it("accepts a public key and refuses a private one", () => {
    const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@host";
    expect(normalizePublicKey(pub)).toBe(pub.split(" ").slice(0, 2).join(" "));
    expect(() => normalizePublicKey("not a key")).toThrow(/valid SSH public key/);
  });
});

describe("files", () => {
  let root: string;
  beforeEach(() => (root = fs.mkdtempSync(path.join(os.tmpdir(), "op-up-files-"))));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("keeps every path inside the camera's folder", () => {
    expect(cleanVirtual("../../etc/passwd")).toBe("/etc/passwd");
    expect(jailPath(root, "/../../etc/passwd")).toBe(path.join(root, "etc", "passwd"));
    expect(jailPath(root, "DCIM\\100NIKON\\a.jpg")).toBe(path.join(root, "DCIM", "100NIKON", "a.jpg"));
  });
  it("refuses a symlink that points outside", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "op-up-out-"));
    fs.symlinkSync(outside, path.join(root, "escape"));
    expect(() => jailPath(root, "/escape/a.jpg")).toThrow();
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it("files top-level uploads into a day folder only when asked", () => {
    expect(landingVirtual("/DSC_1.NEF", { sortByDay: true, today: "2026-11-14" })).toBe("/2026-11-14/DSC_1.NEF");
    expect(landingVirtual("/Sub/DSC_1.NEF", { sortByDay: true, today: "2026-11-14" })).toBe("/Sub/DSC_1.NEF");
    expect(landingVirtual("/DSC_1.NEF", { sortByDay: false, today: "2026-11-14" })).toBe("/DSC_1.NEF");
  });
  it("sweeps old partial uploads but not new ones or real photos", () => {
    const old = path.join(root, ".a.jpg.1234.uploading");
    const fresh = path.join(root, ".b.jpg.1234.uploading");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(fresh, "x");
    fs.writeFileSync(path.join(root, "c.jpg"), "x");
    expect(sweepStaleUploads(root, 1000, Date.now() + 5000 - 0)).toBe(2);
    fs.writeFileSync(fresh, "x");
    expect(sweepStaleUploads(root, 86_400_000)).toBe(0);
    expect(fs.existsSync(path.join(root, "c.jpg"))).toBe(true);
  });
});

describe("upload servers", () => {
  let app: FastifyInstance;
  let root: string;
  let incoming: string;
  let cookie: string;
  let sftpPort: number;
  let ftpPort: number;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "op-up-"));
    sftpPort = await freePort();
    ftpPort = await freePort();
    const passiveMin = await freePort();
    app = await buildApp({
      config: loadConfig({
        OPENPORTRAIT_DATA_ROOT: root,
        WEB_DIR: path.join(root, "web"),
        SFTP_PORT: String(sftpPort),
        FTP_PORT: String(ftpPort),
        FTP_PASSIVE_MIN: String(Math.max(passiveMin, 1024)),
        FTP_PASSIVE_MAX: String(Math.max(passiveMin, 1024) + 8),
      }),
      startBackground: false, setupCode: null,
      logger: false,
    });
    incoming = app.ctx.config.incomingDir;
    const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
    cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  });
  afterEach(async () => {
    await app.ctx.uploads.stop();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const put = async (settings: object = {}) => {
    const current = (await app.inject({ method: "GET", url: "/api/studio/upload", headers: { cookie } })).json().settings;
    return app.inject({ method: "PUT", url: "/api/studio/upload/settings", headers: { cookie }, payload: { ...current, ...settings } });
  };
  const addCamera = async (label: string) => (await app.inject({ method: "POST", url: "/api/studio/upload/accounts", headers: { cookie }, payload: { label } })).json() as { id: string; username: string; password: string; folder: string };

  function sftpConnect(username: string, password: string) {
    return new Promise<{ client: SshClient; sftp: import("ssh2").SFTPWrapper }>((resolve, reject) => {
      const client = new SshClient();
      client.on("ready", () => client.sftp((err, sftp) => (err ? reject(err) : resolve({ client, sftp }))));
      client.on("error", reject);
      client.on("close", () => reject(new Error("connection closed")));
      client.connect({ host: "127.0.0.1", port: sftpPort, username, password, readyTimeout: 5000 });
    });
  }
  const sftpWrite = (sftp: import("ssh2").SFTPWrapper, remote: string, data: Buffer) =>
    new Promise<void>((resolve, reject) => {
      const w = sftp.createWriteStream(remote);
      w.on("close", () => resolve());
      w.on("error", reject);
      w.end(data);
    });

  it("requires a signed-in owner and starts closed", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/upload" })).statusCode).toBe(401);
    const state = (await app.inject({ method: "GET", url: "/api/studio/upload", headers: { cookie } })).json();
    expect(state.settings).toMatchObject({ protocol: "sftp", mode: "on_demand" });
    expect(state.status.state).toBe("closed");
    expect(await canConnect(sftpPort)).toBe(false);
  });

  it("opens on demand, takes a photo over SFTP with a password, files it by day, and closes", async () => {
    const cam = await addCamera("Nikon Z9");
    expect(cam.password).toHaveLength(16);
    const open = await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 30 } });
    expect(open.json()).toMatchObject({ state: "open", openReason: "manual", protocol: "sftp" });

    const { client, sftp } = await sftpConnect(cam.username, cam.password);
    await sftpWrite(sftp, "/DSC_0001.NEF", Buffer.from("raw bytes"));
    client.end();
    const day = new Date().toISOString().slice(0, 10);
    const landed = path.join(incoming, cam.folder, day, "DSC_0001.NEF");
    expect(fs.readFileSync(landed, "utf8")).toBe("raw bytes");
    expect(fs.readdirSync(path.join(incoming, cam.folder, day)).filter((n) => n.endsWith(".uploading"))).toEqual([]);

    const state = (await app.inject({ method: "GET", url: "/api/studio/upload", headers: { cookie } })).json();
    expect(state.accounts[0]).toMatchObject({ filesReceived: 1, bytesReceived: 9 });
    expect(state.status.lastFile).toMatchObject({ name: "DSC_0001.NEF", camera: "Nikon Z9" });

    const closed = await app.inject({ method: "POST", url: "/api/studio/upload/close", headers: { cookie } });
    expect(closed.json().state).toBe("closed");
    expect(await canConnect(sftpPort)).toBe(false);
    const actions = app.ctx.uploads.recentEvents().map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["upload.opened", "upload.closed"]));
  });

  it("rejects a wrong password, blocks repeated guessing, and can't read, delete or escape", { timeout: 20000 }, async () => {
    const cam = await addCamera("Canon R5");
    await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 30 } });
    await expect(sftpConnect(cam.username, "wrong-password")).rejects.toThrow();

    const { client, sftp } = await sftpConnect(cam.username, cam.password);
    await sftpWrite(sftp, "/x.jpg", Buffer.from("1"));
    await sftpWrite(sftp, "/../../escape.jpg", Buffer.from("2"));
    // Landed inside the camera's folder, not above it.
    expect(fs.existsSync(path.join(incoming, "escape.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(incoming, cam.folder, new Date().toISOString().slice(0, 10), "escape.jpg"))).toBe(true);
    const day = new Date().toISOString().slice(0, 10);
    await expect(new Promise((res, rej) => sftp.readFile(`/${day}/x.jpg`, (e, d) => (e ? rej(e) : res(d))))).rejects.toThrow();
    await expect(new Promise((res, rej) => sftp.unlink(`/${day}/x.jpg`, (e) => (e ? rej(e) : res(null))))).rejects.toThrow();
    expect(fs.existsSync(path.join(incoming, cam.folder, day, "x.jpg"))).toBe(true);
    client.end();

    for (let i = 0; i < 7; i++) await sftpConnect(cam.username, "nope").catch(() => undefined);
    await expect(sftpConnect(cam.username, cam.password)).rejects.toThrow(); // this address is now blocked
    expect(app.ctx.uploads.recentEvents().map((e) => e.action)).toContain("upload.blocked");
  });

  it("keeps cameras apart and leaves no partial file when a camera drops", async () => {
    const a = await addCamera("Camera A");
    const b = await addCamera("Camera B");
    await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 30 } });
    const { client, sftp } = await sftpConnect(a.username, a.password);
    await sftpWrite(sftp, "/a.jpg", Buffer.from("a"));
    const entries = await new Promise<string[]>((res, rej) => sftp.readdir("/", (e, l) => (e ? rej(e) : res(l.map((x) => x.filename)))));
    expect(entries).toEqual([new Date().toISOString().slice(0, 10)]);
    // Start a file and drop the connection without closing it.
    await new Promise<void>((res, rej) => sftp.open("/partial.nef", "w", (e, h) => (e ? rej(e) : sftp.write(h, Buffer.from("half"), 0, 4, 0, (e2) => (e2 ? rej(e2) : res())))));
    client.destroy();
    await new Promise((r) => setTimeout(r, 200));
    const left = fs.readdirSync(path.join(incoming, a.folder), { recursive: true }).map(String);
    expect(left.some((n) => n.includes("partial"))).toBe(false);
    expect(fs.existsSync(path.join(incoming, b.folder, new Date().toISOString().slice(0, 10), "a.jpg"))).toBe(false);
  });

  it("supports plain FTP when chosen, with the same scoping", async () => {
    await put({ protocol: "ftp", passiveHost: "127.0.0.1" });
    const cam = await addCamera("Sony A1");
    const open = await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 30 } });
    expect(open.json()).toMatchObject({ state: "open", protocol: "ftp", port: ftpPort });
    expect(await canConnect(sftpPort)).toBe(false);

    const ftp = new FtpClient(5000);
    await ftp.access({ host: "127.0.0.1", port: ftpPort, user: cam.username, password: cam.password, secure: false });
    await ftp.uploadFrom(Readable.from([Buffer.from("jpeg data")]), "DSC00001.JPG");
    await expect(ftp.remove("DSC00001.JPG")).rejects.toThrow();
    await expect(ftp.downloadTo(path.join(root, "x"), "DSC00001.JPG")).rejects.toThrow();
    ftp.close();
    const day = new Date().toISOString().slice(0, 10);
    expect(fs.readFileSync(path.join(incoming, cam.folder, day, "DSC00001.JPG"), "utf8")).toBe("jpeg data");

    const bad = new FtpClient(5000);
    await expect(bad.access({ host: "127.0.0.1", port: ftpPort, user: cam.username, password: "wrong", secure: false })).rejects.toThrow();
    bad.close();
  });

  it("supports FTPS with a generated certificate", { timeout: 30000 }, async () => {
    await put({ protocol: "ftps", passiveHost: "127.0.0.1" });
    const cam = await addCamera("Nikon Z8");
    await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 30 } });
    const ftp = new FtpClient(5000);
    await ftp.access({ host: "127.0.0.1", port: ftpPort, user: cam.username, password: cam.password, secure: true, secureOptions: { rejectUnauthorized: false } });
    await ftp.uploadFrom(Readable.from([Buffer.from("secure")]), "a.jpg");
    ftp.close();
    expect(fs.existsSync(path.join(incoming, cam.folder, new Date().toISOString().slice(0, 10), "a.jpg"))).toBe(true);
    const cert = await app.inject({ method: "GET", url: "/api/studio/upload/ftps-certificate", headers: { cookie } });
    expect(cert.body).toContain("BEGIN CERTIFICATE");
  });

  it("opens and closes by itself in scheduled mode", async () => {
    const all = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }];
    expect((await put({ mode: "scheduled", schedule: [] })).statusCode).toBe(400);
    const open = (await put({ mode: "scheduled", schedule: all })).json();
    expect(open.status).toMatchObject({ state: "open", openReason: "schedule", mode: "scheduled" });
    expect(await canConnect(sftpPort)).toBe(true);
    const shut = await app.inject({ method: "POST", url: "/api/studio/upload/close", headers: { cookie } });
    expect(shut.json().state).toBe("closed");
    const none = (await put({ mode: "scheduled", schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", end: "03:01" }] })).json();
    expect(none.status.opensAt).toBeGreaterThan(Date.now());
  });

  it("needs a confirmation for always-on and stays open", async () => {
    const refused = await put({ mode: "always_on" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("confirm_required");
    const ok = await put({ mode: "always_on", confirmAlwaysOn: true });
    expect(ok.json().status).toMatchObject({ state: "open", openReason: "always", closesAt: null });
    expect(await canConnect(sftpPort)).toBe(true);
    // Back to on-demand closes it.
    const back = await put({ mode: "on_demand" });
    expect(back.json().status.state).toBe("closed");
  });

  it("opens when a live view asks and not when someone just closed it", async () => {
    expect(await canConnect(sftpPort)).toBe(false);
    const asked = await app.inject({ method: "POST", url: "/api/studio/upload/demand", headers: { cookie } });
    expect(asked.statusCode).toBe(200);
    await app.ctx.uploads.tick();
    expect(app.ctx.uploads.status().openReason).toBe("demand");
    await app.inject({ method: "POST", url: "/api/studio/upload/close", headers: { cookie } });
    app.ctx.uploads.demand();
    await app.ctx.uploads.tick();
    expect(app.ctx.uploads.status().state).toBe("closed");
  });

  it("explains a port that is already taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(sftpPort, "0.0.0.0", r));
    const res = await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 5 } });
    expect(res.json()).toMatchObject({ state: "error" });
    expect(res.json().lastError).toMatch(/already in use.*SFTP_PORT/);
    blocker.close();
  });

  it("resets a password, disables a login and removes it", async () => {
    const cam = await addCamera("Camera");
    await app.inject({ method: "POST", url: "/api/studio/upload/open", headers: { cookie }, payload: { minutes: 30 } });
    const reset = (await app.inject({ method: "POST", url: `/api/studio/upload/accounts/${cam.id}/reset-password`, headers: { cookie } })).json();
    await expect(sftpConnect(cam.username, cam.password)).rejects.toThrow();
    (await sftpConnect(cam.username, reset.password)).client.end();
    await app.inject({ method: "PATCH", url: `/api/studio/upload/accounts/${cam.id}`, headers: { cookie }, payload: { disabled: true } });
    await expect(sftpConnect(cam.username, reset.password)).rejects.toThrow();
    expect((await app.inject({ method: "DELETE", url: `/api/studio/upload/accounts/${cam.id}`, headers: { cookie } })).statusCode).toBe(200);
  });
});

describe("home network address", () => {
  let app: FastifyInstance;
  let root: string;
  let cookie: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "op-lan-"));
    app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), OPENPORTRAIT_PLATFORM: "unraid" }), startBackground: false, setupCode: null, logger: false });
    const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "S", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: "UTC" } });
    cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shows no address until one is set, rather than the container's own", async () => {
    const sources = (await app.inject({ method: "GET", url: "/api/studio/tether/sources", headers: { cookie } })).json();
    expect(sources.lan).toMatchObject({ url: null, host: null });
    const cam = (await app.inject({ method: "GET", url: "/api/studio/upload", headers: { cookie, host: "studio.example.com" } })).json();
    expect(cam.connect.hosts).toEqual([]);
  });

  it("serves the saved home address to tethering, camera upload and the AI connect page", async () => {
    const saved = await app.inject({ method: "PUT", url: "/api/studio/internet/lan-url", headers: { cookie }, payload: { url: "192.168.1.20:8090/" } });
    expect(saved.json().lan).toMatchObject({ url: "http://192.168.1.20:8090", host: "192.168.1.20", source: "settings" });
    const sources = (await app.inject({ method: "GET", url: "/api/studio/tether/sources", headers: { cookie } })).json();
    expect(sources.lan.url).toBe("http://192.168.1.20:8090");
    // A public host name (such as the tunnel) is never offered to a camera; the home address is.
    const cam = (await app.inject({ method: "GET", url: "/api/studio/upload", headers: { cookie, host: "studio.example.com" } })).json();
    expect(cam.connect.hosts).toEqual(["192.168.1.20"]);
    const ai = (await app.inject({ method: "GET", url: "/api/studio/ai", headers: { cookie } })).json();
    expect(ai.urls.lan).toBe("http://192.168.1.20:8090/mcp");
    const cleared = await app.inject({ method: "PUT", url: "/api/studio/internet/lan-url", headers: { cookie }, payload: { url: "" } });
    expect(cleared.json().lan.url).toBeNull();
  });

  it("uses the template variable until a saved address overrides it", async () => {
    await app.close();
    app = await buildApp({ config: loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web"), LAN_URL: "http://10.0.0.9:8080", OPENPORTRAIT_PLATFORM: "unraid" }), startBackground: false, setupCode: null, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/studio/auth/login", payload: { email: "pat@example.com", password: "correct horse battery" } });
    cookie = `op_session=${login.cookies.find((c) => c.name === "op_session")!.value}`;
    expect((await app.inject({ method: "GET", url: "/api/studio/internet", headers: { cookie } })).json().lan).toMatchObject({ url: "http://10.0.0.9:8080", source: "template" });
    expect((await app.inject({ method: "PUT", url: "/api/studio/internet/lan-url", headers: { cookie }, payload: { url: "http://192.168.1.20:8090" } })).json().lan.source).toBe("settings");
  });

  it("rejects something that isn't an address", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/studio/internet/lan-url", headers: { cookie }, payload: { url: "http://" } });
    expect(res.statusCode).toBe(400);
  });
});
