import path from "node:path";
import fs from "node:fs";
import { Writable } from "node:stream";
import ftpSrv, { type FileSystem as FileSystemType, type FtpConnection, type FtpServer as FtpServerType } from "ftp-srv";
import type { CameraLogin } from "./accounts.js";
import { IncomingFile, jailPath, landingVirtual } from "./files.js";
import type { ProtocolServer, ServerHooks } from "./types.js";

// The package's CommonJS export carries the classes below at runtime, but its type definitions only declare them as named exports.
const lib = ftpSrv as unknown as {
  FileSystem: typeof FileSystemType;
  ftpErrors: { FileSystemError: new (message: string, code?: number) => Error; GeneralError: new (message: string, code?: number) => Error };
};
const ftpErrors = lib.ftpErrors;
const FtpSrv = ftpSrv as unknown as new (options: ConstructorParameters<typeof FtpServerType>[0]) => FtpServerType;
type FtpSrv = FtpServerType;
const BaseFileSystem = lib.FileSystem;

// ftp-srv's runtime helpers that its type definitions don't list.
type Resolver = { _resolvePath(p: string): { fsPath: string; clientPath: string } };

/**
 * A camera's view of the world: its own folder in Incoming. Upload-only, like the SFTP server. Files arrive
 * under a hidden temporary name and are renamed into place when the camera finishes.
 */
class CameraFs extends BaseFileSystem {
  private open = new Set<IncomingFile>();

  constructor(
    connection: FtpConnection,
    root: string,
    private readonly ctx: { hooks: ServerHooks; login: CameraLogin; ip: string; registry: Set<IncomingFile> },
  ) {
    super(connection, { root, cwd: "/" });
  }

  private checked(p: string): { fsPath: string; clientPath: string } {
    const r = (this as unknown as Resolver)._resolvePath(p);
    try {
      jailPath(this.root, r.clientPath);
    } catch {
      throw new ftpErrors.FileSystemError("Not allowed");
    }
    return r;
  }

  override get(fileName: string) {
    this.checked(fileName);
    return super.get(fileName);
  }
  override list(p = ".") {
    this.checked(p);
    return super.list(p).then((items: Array<{ name: string }>) => items.filter((i) => !(i.name.startsWith(".") && i.name.endsWith(".uploading"))));
  }
  override chdir(p = ".") {
    const { fsPath } = this.checked(p);
    // A camera's destination folder has to exist and some can't create it, so a folder that's asked for is created.
    fs.mkdirSync(fsPath, { recursive: true });
    return super.chdir(p);
  }
  override mkdir(p: string) {
    this.checked(p);
    return super.mkdir(p);
  }
  override rename(from: string, to: string) {
    this.checked(from);
    this.checked(to);
    return super.rename(from, to);
  }
  override read(): Promise<never> {
    return Promise.reject(new ftpErrors.FileSystemError("Downloads are turned off on this server."));
  }
  override delete(): Promise<never> {
    return Promise.reject(new ftpErrors.FileSystemError("Deleting is turned off on this server."));
  }
  override chmod() {
    return Promise.resolve();
  }

  override write(fileName: string, { append = false }: { append?: boolean; start?: unknown } = {}) {
    const { clientPath } = this.checked(fileName);
    const land = this.ctx.hooks.land();
    const target = landingVirtual(clientPath, land);
    const full = jailPath(this.root, target);
    if (full === path.resolve(this.root)) throw new ftpErrors.FileSystemError("Not allowed");
    const file = IncomingFile.open(full, { append });
    this.open.add(file);
    this.ctx.registry.add(file);
    this.ctx.hooks.onActivity();
    let finished = false;
    const stream = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.ctx.hooks.onActivity();
        file.write(chunk, null, cb);
      },
      final: (cb) => {
        file.finish((err) => {
          finished = true;
          this.open.delete(file);
          this.ctx.registry.delete(file);
          if (!err) this.ctx.hooks.onFile(this.ctx.login, { name: file.name, bytes: file.bytes, ip: this.ctx.ip });
          cb(err);
        });
      },
      destroy: (err, cb) => {
        if (!finished) {
          file.abort();
          this.open.delete(file);
          this.ctx.registry.delete(file);
        }
        cb(err);
      },
    });
    return { stream, clientPath };
  }

  /** Called when the camera disconnects, so a dropped transfer leaves no partial file. */
  abortAll() {
    for (const f of this.open) {
      f.abort();
      this.ctx.registry.delete(f);
    }
    this.open.clear();
  }
}

/**
 * A camera that powers down its Wi-Fi to save battery, or walks out of range, drops its connection without saying
 * goodbye, and reconnects when it has more to send. That's normal, so it isn't worth a warning.
 */
export function isRoutineDisconnect(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  return /ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ERR_STREAM_PREMATURE_CLOSE|ERR_STREAM_DESTROYED|socket hang up|read ECONN|This socket has been ended/i.test(text);
}

/** A bunyan-shaped logger that forwards warnings and errors to the app log and drops the chatter. */
function quietLogger(log: ServerHooks["log"]) {
  const self: Record<string, unknown> = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (...a: unknown[]) => log.warn({ ftp: a.map(String).join(" ") }, "FTP"),
    error: (...a: unknown[]) => {
      if (isRoutineDisconnect(a[0])) return;
      log.warn({ ftp: a.map(String).join(" ") }, "FTP");
    },
    fatal: (...a: unknown[]) => log.error({ ftp: a.map(String).join(" ") }, "FTP"),
    child: () => self,
  };
  return self;
}

export interface FtpOptions {
  port: number;
  passiveMin: number;
  passiveMax: number;
  /** The address cameras should connect back to for data. In Docker this is the host's LAN address, not the container's. */
  passiveHost: () => string;
  /** Present for FTPS (explicit TLS on the normal FTP port); absent for plain FTP. */
  tls?: { cert: string; key: string };
}

export class FtpUploadServer implements ProtocolServer {
  private server: FtpSrv | null = null;
  private sessions = new Map<string, CameraFs>();
  private registry = new Set<IncomingFile>();

  constructor(
    private readonly hooks: ServerHooks,
    private readonly opts: FtpOptions,
  ) {}

  port(): number {
    const net = (this.server as unknown as { server?: { address(): unknown } } | null)?.server?.address();
    return net && typeof net === "object" ? (net as { port: number }).port : this.opts.port;
  }
  connections(): number {
    return this.server ? Object.keys((this.server as unknown as { connections?: object }).connections ?? {}).length : 0;
  }
  transfers(): number {
    return this.registry.size;
  }

  async start(): Promise<void> {
    const { hooks, opts } = this;
    const server = new FtpSrv({
      url: `ftp://0.0.0.0:${opts.port}`,
      pasv_url: ((_clientIp: string) => opts.passiveHost()) as unknown as string,
      pasv_min: opts.passiveMin,
      pasv_max: opts.passiveMax,
      tls: opts.tls ? { cert: opts.tls.cert, key: opts.tls.key, minVersion: "TLSv1.2" } : false,
      anonymous: false,
      greeting: "OpenPortrait camera upload",
      // Cameras on hotspots can go quiet for a while between shots; drop truly dead sessions after 10 minutes.
      timeout: 10 * 60_000,
      log: quietLogger(hooks.log),
    });
    this.server = server;

    (server as unknown as NodeJS.EventEmitter).on("connect", ({ connection }: { connection: FtpConnection }) => {
      if (hooks.blocked(connection.ip)) void connection.close(0, 0 as never);
      hooks.onActivity();
    });
    server.on("login", ({ connection, username, password }, resolve, reject) => {
      void (async () => {
        const ip = connection.ip;
        const login = await hooks.authenticate(username, password, ip);
        if (!login) return reject(new ftpErrors.GeneralError("Login incorrect.", 530));
        const root = path.join(hooks.incomingDir, login.folder);
        fs.mkdirSync(root, { recursive: true });
        const cameraFs = new CameraFs(connection, root, { hooks, login, ip, registry: this.registry });
        this.sessions.set(connection.id, cameraFs);
        resolve({ fs: cameraFs, root, cwd: "/" });
      })();
    });
    server.on("disconnect", ({ id }: { id: string }) => {
      this.sessions.get(id)?.abortAll();
      this.sessions.delete(id);
      hooks.onActivity();
    });
    server.on("client-error", ({ error }: { error: Error }) => {
      if (!isRoutineDisconnect(error)) hooks.log.warn({ err: error.message }, "FTP client error");
    });

    await server.listen();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sessions.values()) s.abortAll();
    this.sessions.clear();
    if (server) await Promise.resolve(server.close());
  }
}
