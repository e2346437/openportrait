import { desc, like } from "drizzle-orm";
import type { AppConfig } from "@openportrait/config";
import { tables, type Db } from "@openportrait/db";
import type { Settings } from "../settings.js";
import { ymdIn } from "../domain/time.js";
import { CameraAccounts, type CameraLogin } from "./accounts.js";
import { FtpUploadServer } from "./ftp.js";
import { scheduleProblem, scheduleState, type ScheduleWindow } from "./schedule.js";
import { SftpServer, loadHostKey } from "./sftp.js";
import { ensureFtpsCert } from "./tls.js";
import type { ProtocolServer, ServerHooks } from "./types.js";

export type UploadProtocol = "sftp" | "ftp" | "ftps";
export type UploadMode = "on_demand" | "scheduled" | "always_on";
export type OpenReason = "always" | "schedule" | "manual" | "demand";

export interface UploadStatus {
  state: "open" | "closed" | "error";
  protocol: UploadProtocol;
  mode: UploadMode;
  openReason: OpenReason | null;
  /** When the server will close by itself, if it will. */
  closesAt: number | null;
  /** When it will next open by itself (scheduled mode only). */
  opensAt: number | null;
  connections: number;
  transfers: number;
  port: number;
  passiveRange: { min: number; max: number } | null;
  lastError: string | null;
  lastFile: { name: string; camera: string; at: number } | null;
}

const MIN = 60_000;
const DEFAULT_IDLE = 30;
const MAX_FAILS = 6;
const FAIL_WINDOW = 10 * MIN;
const BLOCK_FOR = 15 * MIN;

export interface UploadManagerDeps {
  config: AppConfig;
  db: Db;
  settings: Settings;
  log: ServerHooks["log"];
  lanAddresses: () => string[];
}

/**
 * Owns the camera upload servers and decides when they're open. Nothing listens unless the access mode says
 * it should: on demand (a person or a live-view page asked), on a schedule, or always. Every open and close is
 * written to the audit log.
 */
export class UploadManager {
  readonly accounts: CameraAccounts;
  private readonly hostKey: { pem: string; fingerprint: string };
  private server: ProtocolServer | null = null;
  private runningWith = "";
  private reason: OpenReason | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busyChanging: Promise<void> = Promise.resolve();
  /** Epoch ms until which a person asked for the server to stay open. */
  private openUntil = 0;
  /** Epoch ms until which activity (a camera, a live view) keeps an on-demand server open. */
  private demandUntil = 0;
  /** Epoch ms until which a person closed it, so lingering activity doesn't reopen it. */
  private forceClosedUntil = 0;
  /** After a failed start, wait until this time before trying again on its own. */
  private retryAt = 0;
  private lastFile: UploadStatus["lastFile"] = null;
  private fails = new Map<string, { at: number[]; blockedUntil: number; lastLogged: number }>();

  constructor(private readonly deps: UploadManagerDeps) {
    this.accounts = new CameraAccounts(deps.db);
    this.hostKey = loadHostKey(deps.config.configDir);
  }

  // ---- settings with their defaults ----

  protocol(): UploadProtocol {
    return this.deps.settings.get("upload.protocol") ?? this.deps.config.uploadProtocol;
  }
  mode(): UploadMode {
    return this.deps.settings.get("upload.mode") ?? this.deps.config.uploadAccessMode;
  }
  idleMinutes(): number {
    return this.deps.settings.get("upload.idleMinutes") ?? DEFAULT_IDLE;
  }
  schedule(): ScheduleWindow[] {
    return this.deps.settings.get("upload.schedule") ?? [];
  }
  sortByDay(): boolean {
    return this.deps.settings.get("upload.sortByDay") ?? true;
  }
  timezone(): string {
    return this.deps.settings.get("studio.timezone") ?? "UTC";
  }
  passiveHost(): string {
    return (this.deps.settings.get("upload.passiveHost") ?? "").trim();
  }
  hostFingerprint(): string {
    return this.hostKey.fingerprint;
  }

  // ---- lifecycle ----

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.change(() => this.close("shutdown", false));
  }

  /** Applies a settings change right away instead of at the next 10-second check. */
  refresh(): Promise<void> {
    this.retryAt = 0;
    return this.tick();
  }

  // ---- asking for access ----

  /** A person asks for the server to be open for a while. */
  openFor(minutes: number): Promise<void> {
    const m = Math.max(1, Math.min(minutes, 24 * 60));
    this.forceClosedUntil = 0;
    this.retryAt = 0;
    this.openUntil = Date.now() + m * MIN;
    return this.tick();
  }

  /** A person closes the server now. In scheduled mode it stays closed until the current window ends. */
  closeNow(): Promise<void> {
    const now = Date.now();
    this.openUntil = 0;
    this.demandUntil = 0;
    const sched = this.mode() === "scheduled" ? scheduleState(this.schedule(), this.timezone(), now) : null;
    this.forceClosedUntil = sched?.closesAt ?? now + 10 * MIN;
    return this.tick();
  }

  /**
   * Something needs the server: a live-view page is open, say. Opens an on-demand server and keeps it open
   * for the idle time. Ignored in other modes, and for a few minutes after a person closed the server.
   */
  demand(): void {
    if (this.mode() !== "on_demand" || Date.now() < this.forceClosedUntil) return;
    const wasOpen = this.server !== null;
    this.demandUntil = Math.max(this.demandUntil, Date.now() + this.idleMinutes() * MIN);
    if (!wasOpen) void this.tick();
  }

  // ---- the decision ----

  private decide(now: number): { open: boolean; reason: OpenReason | null; closesAt: number | null; opensAt: number | null } {
    const mode = this.mode();
    const sched = mode === "scheduled" ? scheduleState(this.schedule(), this.timezone(), Math.max(now, this.forceClosedUntil)) : null;
    const closed = (): { open: false; reason: null; closesAt: null; opensAt: number | null } => ({ open: false, reason: null, closesAt: null, opensAt: sched ? (sched.open ? this.forceClosedUntil : sched.nextOpenAt) : null });
    if (now < this.forceClosedUntil) return closed();
    if (this.openUntil > now) return { open: true, reason: "manual", closesAt: this.openUntil, opensAt: null };
    if (mode === "always_on") return { open: true, reason: "always", closesAt: null, opensAt: null };
    if (mode === "scheduled") {
      const s = scheduleState(this.schedule(), this.timezone(), now);
      if (s.open) return { open: true, reason: "schedule", closesAt: s.closesAt, opensAt: null };
      return { open: false, reason: null, closesAt: null, opensAt: s.nextOpenAt };
    }
    if (this.demandUntil > now) return { open: true, reason: "demand", closesAt: this.demandUntil, opensAt: null };
    return closed();
  }

  private signature(): string {
    return [this.protocol(), this.passiveHost(), this.deps.config.sftpPort, this.deps.config.ftpPort].join("|");
  }

  private pendingTick: Promise<void> = Promise.resolve();
  tick(): Promise<void> {
    this.pendingTick = this.pendingTick.then(() => this.doTick());
    return this.pendingTick;
  }

  private async doTick(): Promise<void> {
    {
      const now = Date.now();
      const want = this.decide(now);
      await this.change(async () => {
        if (want.open) {
          if (this.server && this.runningWith !== this.signature()) await this.close("settings_changed", true);
          if (!this.server && now >= this.retryAt) await this.open(want.reason ?? "manual");
          else this.reason = want.reason;
        } else if (this.server) {
          // Never cut a photo in half: let a running transfer finish unless a person closed the server.
          const forced = now < this.forceClosedUntil;
          if (forced || this.server.transfers() === 0) await this.close(forced ? "closed_by_user" : this.closeReason(), false);
        }
      });
    }
  }

  private closeReason(): string {
    return this.mode() === "scheduled" ? "schedule_ended" : this.mode() === "on_demand" ? "idle" : "mode_changed";
  }

  private change(fn: () => Promise<void>): Promise<void> {
    const next = this.busyChanging.then(fn, fn);
    this.busyChanging = next.catch(() => undefined);
    return next;
  }

  private async open(reason: OpenReason): Promise<void> {
    const { config } = this.deps;
    const protocol = this.protocol();
    const hooks = this.hooks();
    try {
      if (protocol === "sftp") {
        this.server = new SftpServer(hooks, { port: config.sftpPort, hostKey: this.hostKey.pem });
      } else {
        const tls = protocol === "ftps" ? await ensureFtpsCert(config.configDir, [this.passiveHost(), ...this.deps.lanAddresses()]) : undefined;
        this.server = new FtpUploadServer(hooks, {
          port: config.ftpPort,
          passiveMin: config.ftpPassiveMin,
          passiveMax: config.ftpPassiveMax,
          passiveHost: () => this.passiveHost() || this.deps.lanAddresses()[0] || "127.0.0.1",
          tls: tls ? { cert: tls.cert, key: tls.key } : undefined,
        });
      }
      await this.server.start();
      this.runningWith = this.signature();
      this.reason = reason;
      this.lastError = null;
      this.audit("upload.opened", { reason, protocol });
      this.deps.log.info({ protocol, reason }, "camera upload server opened");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.lastError =
        code === "EADDRINUSE"
          ? `Port ${protocol === "sftp" ? config.sftpPort : config.ftpPort} is already in use. Change ${protocol === "sftp" ? "SFTP_PORT" : "FTP_PORT"} in the container settings.`
          : `The upload server couldn't start: ${(err as Error).message}`;
      this.deps.log.warn({ err: String(err) }, "camera upload server failed to start");
      try {
        await this.server?.stop();
      } catch {
        /* nothing listening */
      }
      this.server = null;
      this.reason = null;
      // Don't retry every 10 seconds and flood the log: wait a minute, or until a person asks again.
      this.retryAt = Date.now() + MIN;
      this.audit("upload.failed", { reason, protocol, error: this.lastError });
    }
  }

  private async close(why: string, willReopen: boolean): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.reason = null;
    try {
      await server.stop();
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "camera upload server stop error");
    }
    if (!willReopen) this.audit("upload.closed", { reason: why });
    this.deps.log.info({ reason: why }, "camera upload server closed");
  }

  // ---- hooks for the protocol servers ----

  private hooks(): ServerHooks {
    return {
      incomingDir: this.deps.config.incomingDir,
      authenticate: (username, password, ip) => this.authenticate(username, password, ip),
      findLogin: (username) => this.accounts.find(username),
      authFailed: (username, ip) => this.failed(username, ip),
      blocked: (ip) => this.isBlocked(ip),
      land: () => ({ sortByDay: this.sortByDay(), today: ymdIn(Date.now(), this.timezone()) }),
      onFile: (login, info) => this.onFile(login, info),
      onActivity: () => this.activity(),
      log: this.deps.log,
    };
  }

  private activity(): void {
    if (this.server && this.mode() === "on_demand" && Date.now() >= this.forceClosedUntil) {
      this.demandUntil = Math.max(this.demandUntil, Date.now() + this.idleMinutes() * MIN);
    }
  }

  private onFile(login: CameraLogin, info: { name: string; bytes: number }): void {
    if (!this.server) return;
    this.accounts.recordUpload(login.id, info.bytes);
    this.lastFile = { name: info.name, camera: login.label, at: Date.now() };
    this.activity();
  }

  private async authenticate(username: string, password: string, ip: string): Promise<CameraLogin | null> {
    if (this.isBlocked(ip)) return null;
    const login = await this.accounts.verify(username, password);
    if (login) {
      this.fails.delete(ip);
      return login;
    }
    this.failed(username, ip);
    return null;
  }

  private failed(username: string, ip: string): void {
    const now = Date.now();
    const entry = this.fails.get(ip) ?? { at: [], blockedUntil: 0, lastLogged: 0 };
    entry.at = [...entry.at.filter((t) => now - t < FAIL_WINDOW), now];
    if (entry.at.length >= MAX_FAILS && entry.blockedUntil < now) {
      entry.blockedUntil = now + BLOCK_FOR;
      this.audit("upload.blocked", { ip, minutes: BLOCK_FOR / MIN }, ip);
    } else if (now - entry.lastLogged > MIN) {
      entry.lastLogged = now;
      this.audit("upload.login_failed", { username: username.slice(0, 64) }, ip);
    }
    this.fails.set(ip, entry);
    if (this.fails.size > 500) for (const [k, v] of this.fails) if (v.blockedUntil < now && v.at.every((t) => now - t > FAIL_WINDOW)) this.fails.delete(k);
  }

  private isBlocked(ip: string): boolean {
    return (this.fails.get(ip)?.blockedUntil ?? 0) > Date.now();
  }

  private audit(action: string, detail: object, ip: string | null = null): void {
    try {
      this.deps.db.insert(tables.auditLog).values({ actorType: "system", action, detail, ip }).run();
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "couldn't write upload audit entry");
    }
  }

  // ---- reporting ----

  status(): UploadStatus {
    const { config } = this.deps;
    const protocol = this.protocol();
    const d = this.decide(Date.now());
    const open = this.server !== null;
    return {
      state: this.lastError && !open ? "error" : open ? "open" : "closed",
      protocol,
      mode: this.mode(),
      openReason: open ? (this.reason ?? d.reason) : null,
      closesAt: open ? d.closesAt : null,
      opensAt: open ? null : d.opensAt,
      connections: this.server?.connections() ?? 0,
      transfers: this.server?.transfers() ?? 0,
      port: protocol === "sftp" ? config.sftpPort : config.ftpPort,
      passiveRange: protocol === "sftp" ? null : { min: config.ftpPassiveMin, max: config.ftpPassiveMax },
      lastError: this.lastError,
      lastFile: this.lastFile,
    };
  }

  recentEvents(limit = 20): Array<{ id: number; at: number; action: string; detail: unknown; ip: string | null }> {
    return this.deps.db
      .select()
      .from(tables.auditLog)
      .where(like(tables.auditLog.action, "upload.%"))
      .orderBy(desc(tables.auditLog.at))
      .limit(limit)
      .all()
      .map((r) => ({ id: r.id, at: r.at.getTime(), action: r.action, detail: r.detail, ip: r.ip }));
  }
}

export { scheduleProblem };
