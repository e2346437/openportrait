import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ssh2, { type Connection, type Server as SshServer, type SFTPWrapper } from "ssh2";
import type { CameraLogin } from "./accounts.js";
import { IncomingFile, jailPath, landingVirtual } from "./files.js";
import type { ProtocolServer, ServerHooks } from "./types.js";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

/** Creates the SSH host key on first run so cameras see the same fingerprint every time. */
export function loadHostKey(configDir: string): { pem: string; fingerprint: string } {
  const file = path.join(configDir, "sftp_host_ed25519_key");
  if (!fs.existsSync(file)) {
    // ssh2 occasionally writes a key it can't read back (about 1 in 150), so check each one before keeping it.
    let privateKey = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = utils.generateKeyPairSync("ed25519").private;
      const parsed = utils.parseKey(candidate);
      if (!(parsed instanceof Error) && !(Array.isArray(parsed) && parsed[0] instanceof Error)) {
        privateKey = candidate;
        break;
      }
    }
    if (!privateKey) throw new Error("Couldn't create an SSH host key. Try starting the container again.");
    fs.writeFileSync(file, privateKey, { mode: 0o600, flag: "wx" });
  }
  const pem = fs.readFileSync(file, "utf8");
  const parsed = utils.parseKey(pem);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new Error(`${file} isn't a valid SSH key. Delete it to create a new one (cameras will ask you to trust the new key).`);
  const fingerprint = "SHA256:" + crypto.createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "");
  return { pem, fingerprint };
}

type Handle = { kind: "file"; file: IncomingFile } | { kind: "dir"; entries: fs.Dirent[] | null; dir: string; done: boolean };

function attrsOf(st: fs.Stats) {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function longname(name: string, st: fs.Stats): string {
  const type = st.isDirectory() ? "d" : "-";
  const when = st.mtime.toUTCString().slice(5, 16);
  return `${type}rwxr-xr-x 1 camera camera ${String(st.size).padStart(12)} ${when} ${name}`;
}

/**
 * An upload-only SFTP server. Each login is confined to its own folder in Incoming. Cameras can send files, make
 * folders and list what's there, but can't download or delete, so a stolen camera password can't be used to take
 * photos out.
 */
export class SftpServer implements ProtocolServer {
  private server: SshServer | null = null;
  private clients = new Set<Connection>();
  private active = new Set<IncomingFile>();

  constructor(
    private readonly hooks: ServerHooks,
    private readonly opts: { port: number; hostKey: string },
  ) {}

  port(): number {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : this.opts.port;
  }
  connections(): number {
    return this.clients.size;
  }
  transfers(): number {
    return this.active.size;
  }

  start(): Promise<void> {
    const server = new Server({ hostKeys: [this.opts.hostKey], ident: "OpenPortrait" }, (client, info) => this.onClient(client, info.ip));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        server.on("error", (err: unknown) => this.hooks.log.warn({ err: String(err) }, "SFTP server error"));
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const c of this.clients) c.end();
    for (const f of this.active) f.abort();
    this.active.clear();
    this.clients.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onClient(client: Connection, ip: string) {
    if (this.hooks.blocked(ip)) {
      client.end();
      return;
    }
    this.clients.add(client);
    this.hooks.onActivity();
    let login: CameraLogin | null = null;
    client.on("error", () => undefined);
    client.on("close", () => {
      this.clients.delete(client);
      this.hooks.onActivity();
    });

    client.on("authentication", (ctx) => {
      void (async () => {
        if (this.hooks.blocked(ip)) return ctx.reject([], false);
        if (ctx.method === "password") {
          const found = await this.hooks.authenticate(ctx.username, ctx.password, ip);
          if (found) {
            login = found;
            return ctx.accept();
          }
          return ctx.reject(["password", "publickey"]);
        }
        if (ctx.method === "publickey") {
          const found = this.hooks.findLogin(ctx.username);
          const stored = found?.publicKey ? utils.parseKey(found.publicKey) : null;
          const key = Array.isArray(stored) ? stored[0] : stored;
          const matches = found && key && !(key instanceof Error) && ctx.key.algo === key.type && ctx.key.data.equals(key.getPublicSSH());
          if (!matches) return ctx.reject(["password", "publickey"]);
          if (!ctx.signature) return ctx.accept(); // "would this key be accepted?" probe
          if (key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) {
            login = found;
            return ctx.accept();
          }
          this.hooks.authFailed(ctx.username, ip);
          return ctx.reject(["password", "publickey"]);
        }
        if (ctx.method === "none") return ctx.reject(["password", "publickey"]);
        return ctx.reject(["password", "publickey"]);
      })();
    });

    client.on("ready", () => {
      if (!login) return client.end();
      const me = login;
      client.on("session", (accept) => {
        const session = accept();
        // Shell and exec are not offered: this server only speaks SFTP.
        session.on("sftp", (acceptSftp) => this.serve(acceptSftp(), me, ip));
      });
    });
  }

  private serve(sftp: SFTPWrapper, login: CameraLogin, ip: string) {
    const root = path.join(this.hooks.incomingDir, login.folder);
    fs.mkdirSync(root, { recursive: true });
    const handles = new Map<number, Handle>();
    let nextHandle = 1;
    const mine = new Set<IncomingFile>();

    const newHandle = (h: Handle) => {
      const id = nextHandle++;
      handles.set(id, h);
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(id);
      return buf;
    };
    const getHandle = (buf: Buffer) => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined);
    const resolve = (p: string): string | null => {
      try {
        return jailPath(root, p);
      } catch {
        return null;
      }
    };
    const errStatus = (reqid: number, err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code;
      sftp.status(reqid, code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : code === "EACCES" || code === "EPERM" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
    };
    const denied = (reqid: number) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);

    sftp.on("REALPATH", (reqid: number, p: string) => {
      const v = path.posix.normalize("/" + p.replace(/\\/g, "/")) || "/";
      sftp.name(reqid, [{ filename: v, longname: v, attrs: { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
    });
    const statLike = (follow: boolean) => (reqid: number, p: string) => {
      const full = resolve(p);
      if (!full) return denied(reqid);
      fs[follow ? "stat" : "lstat"](full, (err, st) => (err ? errStatus(reqid, err) : sftp.attrs(reqid, attrsOf(st))));
    };
    sftp.on("STAT", statLike(true));
    sftp.on("LSTAT", statLike(false));
    sftp.on("FSTAT", (reqid: number, handle: Buffer) => {
      const h = getHandle(handle);
      if (h?.kind === "file") return fs.stat(h.file.tempPath, (err, st) => (err ? errStatus(reqid, err) : sftp.attrs(reqid, attrsOf(st))));
      sftp.status(reqid, STATUS_CODE.FAILURE);
    });
    // Cameras often set the modified time after an upload. It's accepted and ignored.
    sftp.on("SETSTAT", (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
    sftp.on("FSETSTAT", (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));

    sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
      const wantsWrite = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
      if (!wantsWrite) return denied(reqid); // downloads are off
      const land = this.hooks.land();
      const target = landingVirtual(filename, land);
      const full = resolve(target);
      if (!full || full === root) return denied(reqid);
      try {
        const file = IncomingFile.open(full, { append: (flags & OPEN_MODE.APPEND) !== 0 });
        this.active.add(file);
        mine.add(file);
        this.hooks.onActivity();
        sftp.handle(reqid, newHandle({ kind: "file", file }));
      } catch (err) {
        errStatus(reqid, err);
      }
    });
    sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
      const h = getHandle(handle);
      if (h?.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
      this.hooks.onActivity();
      h.file.write(data, offset, (err) => (err ? errStatus(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)));
    });
    sftp.on("READ", (reqid: number) => denied(reqid));
    sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
      const key = handle.length === 4 ? handle.readUInt32BE(0) : -1;
      const h = handles.get(key);
      handles.delete(key);
      if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (h.kind === "dir") return sftp.status(reqid, STATUS_CODE.OK);
      h.file.finish((err) => {
        this.active.delete(h.file);
        mine.delete(h.file);
        if (err) return errStatus(reqid, err);
        this.hooks.onFile(login, { name: h.file.name, bytes: h.file.bytes, ip });
        sftp.status(reqid, STATUS_CODE.OK);
      });
    });

    sftp.on("MKDIR", (reqid: number, p: string) => {
      const full = resolve(p);
      if (!full) return denied(reqid);
      fs.mkdir(full, { recursive: true }, (err) => (err ? errStatus(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)));
    });
    sftp.on("RENAME", (reqid: number, from: string, to: string) => {
      const a = resolve(from);
      const b = resolve(to);
      if (!a || !b || a === root || b === root) return denied(reqid);
      fs.rename(a, b, (err) => (err ? errStatus(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)));
    });
    // No deleting: a stolen camera password shouldn't be able to wipe the Incoming folder.
    sftp.on("REMOVE", (reqid: number) => denied(reqid));
    sftp.on("RMDIR", (reqid: number) => denied(reqid));
    sftp.on("SYMLINK", (reqid: number) => denied(reqid));
    sftp.on("READLINK", (reqid: number) => denied(reqid));

    sftp.on("OPENDIR", (reqid: number, p: string) => {
      const full = resolve(p);
      if (!full) return denied(reqid);
      // A camera's destination folder has to exist and some can't create it, so a folder that's asked for is created.
      fs.mkdir(full, { recursive: true }, () => undefined);
      fs.stat(full, (err, st) => {
        if (err) return errStatus(reqid, err);
        if (!st.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
        sftp.handle(reqid, newHandle({ kind: "dir", dir: full, entries: null, done: false }));
      });
    });
    sftp.on("READDIR", (reqid: number, handle: Buffer) => {
      const h = getHandle(handle);
      if (h?.kind !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
      h.done = true;
      fs.readdir(h.dir, { withFileTypes: true }, (err, entries) => {
        if (err) return errStatus(reqid, err);
        const visible = entries.filter((e) => !(e.name.startsWith(".") && e.name.endsWith(".uploading")));
        const out = visible.flatMap((e) => {
          try {
            const st = fs.statSync(path.join(h.dir, e.name));
            return [{ filename: e.name, longname: longname(e.name, st), attrs: attrsOf(st) }];
          } catch {
            return [];
          }
        });
        if (out.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
        sftp.name(reqid, out);
      });
    });

    // A camera that drops mid-photo leaves nothing half-written behind.
    const cleanup = () => {
      for (const f of mine) {
        f.abort();
        this.active.delete(f);
      }
      mine.clear();
    };
    sftp.on("end", cleanup);
    sftp.on("close", cleanup);
    sftp.on("error", () => undefined);
  }
}
