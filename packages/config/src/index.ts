import path from "node:path";

/**
 * Runtime configuration, read once from the environment.
 * Infrastructure only: anything a studio owner changes lives in the Settings table, not here.
 */
export interface AppConfig {
  /** HTTP port the app listens on inside the container. */
  port: number;
  host: string;
  /** Database, secret key, backups. Must be on a real disk, not a FUSE user share. */
  configDir: string;
  /** Gallery originals (the Unraid gallery share). */
  galleriesDir: string;
  /** In-camera uploads before sorting. */
  incomingDir: string;
  /** Generated previews and zips. Safe to delete. */
  cacheDir: string;
  /** Built web UI. */
  webDir: string;
  /** Public base URL, e.g. https://studio.example.com. Empty means "derive it". */
  appUrl: string;
  /** Token for the built-in cloudflared. Can also be set in Settings. */
  tunnelToken: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  /** Backstop rescan interval for the folder watcher. */
  watchRescanMinutes: number;
  ingestSettleSeconds: number;
  /** Camera upload server (see apps/server/src/upload). Ports are infrastructure; protocol and access mode are settings. */
  sftpPort: number;
  ftpPort: number;
  /** Passive data ports for FTP/FTPS. Publish this whole range from the container. */
  ftpPassiveMin: number;
  ftpPassiveMax: number;
  /** First-run defaults for the Settings > Camera upload choices, so a template can pre-select them. */
  uploadProtocol: "sftp" | "ftp" | "ftps";
  uploadAccessMode: "on_demand" | "scheduled" | "always_on";
  /** True when the container runs on Unraid (set by the Unraid template). */
  isUnraid: boolean;
  isProduction: boolean;
}

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got "${value}"`);
  return n;
}

function port(value: string | undefined, fallback: number, name: string): number {
  const n = int(value, fallback, name);
  if (n < 1024 || n > 65535) throw new Error(`${name} must be between 1024 and 65535, got "${value}"`);
  return n;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  return v as T;
}

function url(value: string | undefined): string {
  const v = (value ?? "").trim().replace(/\/+$/, "");
  if (v === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`APP_URL must be a full URL such as https://studio.example.com, got "${v}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`APP_URL must start with https://, got "${v}"`);
  }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const level = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!(LEVELS as readonly string[]).includes(level)) {
    throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(", ")}, got "${level}"`);
  }
  const dataRoot = env.OPENPORTRAIT_DATA_ROOT; // dev convenience: one folder holding everything
  const dir = (key: string, containerPath: string, devName: string) =>
    path.resolve(env[key] ?? (dataRoot ? path.join(dataRoot, devName) : containerPath));

  return {
    port: int(env.PORT, 8080, "PORT"),
    host: env.HOST ?? "0.0.0.0",
    configDir: dir("CONFIG_DIR", "/config", "config"),
    galleriesDir: dir("GALLERIES_DIR", "/galleries", "galleries"),
    incomingDir: dir("INCOMING_DIR", "/incoming", "incoming"),
    cacheDir: dir("CACHE_DIR", "/cache", "cache"),
    webDir: path.resolve(env.WEB_DIR ?? path.join(process.cwd(), "apps/web/dist")),
    appUrl: url(env.APP_URL),
    tunnelToken: (env.CLOUDFLARE_TUNNEL_TOKEN ?? "").trim(),
    logLevel: level as AppConfig["logLevel"],
    watchRescanMinutes: int(env.WATCH_RESCAN_MINUTES, 5, "WATCH_RESCAN_MINUTES"),
    ingestSettleSeconds: int(env.INGEST_SETTLE_SECONDS, 10, "INGEST_SETTLE_SECONDS"),
    sftpPort: port(env.SFTP_PORT, 2222, "SFTP_PORT"),
    ftpPort: port(env.FTP_PORT, 2121, "FTP_PORT"),
    ftpPassiveMin: port(env.FTP_PASSIVE_MIN, 30000, "FTP_PASSIVE_MIN"),
    ftpPassiveMax: port(env.FTP_PASSIVE_MAX, 30009, "FTP_PASSIVE_MAX"),
    uploadProtocol: oneOf(env.UPLOAD_PROTOCOL, ["sftp", "ftp", "ftps"] as const, "sftp", "UPLOAD_PROTOCOL"),
    uploadAccessMode: oneOf(env.UPLOAD_ACCESS_MODE, ["on_demand", "scheduled", "always_on"] as const, "on_demand", "UPLOAD_ACCESS_MODE"),
    isUnraid: env.OPENPORTRAIT_PLATFORM === "unraid",
    isProduction: env.NODE_ENV === "production",
  };
}
