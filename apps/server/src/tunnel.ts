import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type TunnelState = "not-installed" | "off" | "starting" | "connected" | "reconnecting" | "error";

export interface TunnelStatus {
  installed: boolean;
  configured: boolean;
  state: TunnelState;
  /** Public hostnames the tunnel is serving, read from cloudflared's remote configuration. */
  hostnames: string[];
  connections: number;
  lastError: string | null;
  since: number | null;
}

export interface TunnelLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const METRICS = "127.0.0.1:20241";

/** A Cloudflare tunnel token is base64 JSON: {"a": accountTag, "t": tunnelId, "s": secret}. */
export function parseTunnelToken(token: string): { accountTag: string; tunnelId: string } | null {
  try {
    const json = JSON.parse(Buffer.from(token.trim(), "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof json.a === "string" && typeof json.t === "string" && typeof json.s === "string") {
      return { accountTag: json.a, tunnelId: json.t };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Finds the tunnel token in whatever the user pasted: the bare token, or any of the install
 * commands Cloudflare shows (`cloudflared service install eyJ…`, `… run --token eyJ…`,
 * `TUNNEL_TOKEN=eyJ…`). Returns null when nothing in it decodes as a token.
 */
export function extractTunnelToken(input: string): string | null {
  const words = input
    .split(/[\s"']+/)
    .map((w) => w.replace(/^[A-Za-z_]+=/, "")) // TUNNEL_TOKEN=eyJ… (keeps the token's own "=" padding)
    .filter((w) => w.length >= 40);
  for (const w of words.sort((a, b) => b.length - a.length)) {
    if (parseTunnelToken(w)) return w;
  }
  return null;
}

/** Turns a cloudflared ERR log line into something a photographer can act on. */
export function friendlyTunnelError(line: string): string {
  if (/Unauthorized|Invalid tunnel secret|tunnel credentials|token.*(invalid|not valid)/i.test(line)) {
    return "Cloudflare rejected the tunnel token. Copy it again from the Cloudflare dashboard.";
  }
  if (/lookup .*argotunnel\.com|no such host|server misbehaving|i\/o timeout.*:53/i.test(line)) {
    return "This server can't look up Cloudflare's address. Check that the server has internet access and working DNS.";
  }
  if (/failed to dial|connection refused|network is unreachable|handshake.*timeout|timeout: no recent network activity/i.test(line)) {
    return "This server can't reach Cloudflare. Check that outbound connections on port 7844 (UDP and TCP) are allowed by your router or firewall.";
  }
  return line.replace(/^\S+\s+ERR\s+/, "").slice(0, 300);
}

/** Pulls public hostnames out of the "Updated to new configuration" log line. */
export function hostnamesFromLog(line: string): string[] | null {
  if (!line.includes("Updated to new configuration")) return null;
  const found = new Set<string>();
  for (const m of line.matchAll(/\\?"hostname\\?"\s*:\s*\\?"([a-z0-9.-]+)\\?"/gi)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return [...found];
}

function findBinary(): string | null {
  const explicit = process.env.CLOUDFLARED_PATH;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "cloudflared");
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Runs the bundled cloudflared as a child process when a token is set.
 * Changing the token restarts only the tunnel, not the app.
 */
export class TunnelManager {
  private child: ChildProcess | null = null;
  private token = "";
  private restartTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly binary = findBinary();
  private status: TunnelStatus = { installed: false, configured: false, state: "off", hostnames: [], connections: 0, lastError: null, since: null };

  constructor(private readonly logger: TunnelLogger) {
    this.status.installed = this.binary !== null;
    if (!this.binary) this.status.state = "not-installed";
  }

  getStatus(): TunnelStatus {
    return { ...this.status, hostnames: [...this.status.hostnames] };
  }

  setToken(token: string): void {
    const next = token.trim();
    if (next === this.token && this.child) return;
    this.token = next;
    this.status.configured = next !== "";
    this.stopChild();
    this.failures = 0;
    if (next && this.binary) this.startChild();
    else this.status = { ...this.status, state: this.binary ? "off" : "not-installed", connections: 0, hostnames: [], lastError: null, since: null };
  }

  async shutdown(): Promise<void> {
    this.token = "";
    this.stopChild();
  }

  private startChild(): void {
    if (!this.binary) return;
    this.status = { ...this.status, state: "starting", connections: 0, lastError: null, since: Date.now() };
    const child = spawn(this.binary, ["tunnel", "--no-autoupdate", "--metrics", METRICS, "run"], {
      // The token goes in the environment, not argv, so it doesn't show up in `ps`.
      env: { ...process.env, TUNNEL_TOKEN: this.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const onLine = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const hosts = hostnamesFromLog(line);
        if (hosts) this.status.hostnames = hosts;
        if (/ ERR /.test(line)) this.status.lastError = friendlyTunnelError(line);
      }
    };
    child.stdout?.on("data", onLine);
    child.stderr?.on("data", onLine);
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearPoll();
      if (!this.token) return;
      this.failures++;
      const delay = Math.min(2000 * 2 ** (this.failures - 1), 60_000);
      this.status.state = "error";
      this.status.connections = 0;
      this.status.lastError ??= `cloudflared stopped (exit code ${code ?? "unknown"})`;
      this.logger.warn({ code, retryInMs: delay }, "cloudflared exited");
      this.restartTimer = setTimeout(() => this.startChild(), delay);
    });
    this.pollTimer = setInterval(() => void this.pollReady(), 3000);
    this.logger.info({}, "cloudflared started");
  }

  private async pollReady(): Promise<void> {
    try {
      const res = await fetch(`http://${METRICS}/ready`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json().catch(() => ({}))) as { readyConnections?: number };
      const n = body.readyConnections ?? 0;
      const wasConnected = this.status.state === "connected";
      this.status.connections = n;
      if (res.ok && n > 0) {
        this.status.state = "connected";
        this.status.lastError = null;
        this.failures = 0;
        if (!wasConnected) this.status.since = Date.now();
      } else if (wasConnected) {
        this.status.state = "reconnecting";
      }
    } catch {
      // metrics server not up yet
    }
  }

  private clearPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private stopChild(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearPoll();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}
