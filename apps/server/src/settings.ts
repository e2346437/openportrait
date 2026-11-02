import { eq } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import type { Secrets } from "./secrets.js";

/** Every setting the app knows, with its type. Secrets are encrypted at rest. */
export interface SettingTypes {
  "setup.completedAt": number;
  "studio.name": string;
  "studio.email": string;
  "studio.timezone": string;
  /** Set when a logo has been uploaded; changes with each upload. */
  "studio.logoVersion": number;
  "internet.publicUrl": string;
  "internet.trustCloudflare": boolean;
  /** The server's address on the home network (host IP and the port mapped to the container). */
  "internet.lanUrl": string;
  "tunnel.token": string; // secret
  "backup.lastAt": number;
  /** Delivery folder inside each shoot folder; its subfolders are gallery sets. */
  "galleries.deliveryFolder": string;
  /** Other shoot subfolders the gallery watcher never reads (camera originals). */
  "galleries.privateFolders": string[];
  /** Download lock the publish dialog starts on (docs/GALLERIES.md section 6.4). */
  /** Wording laid over previews of payment-locked photos. Empty means the studio name. */
  "galleries.watermarkText": string;
  "galleries.defaultDownloadLock": "until_paid" | "highlights_early" | "none";
  "ai.enabled": boolean;
  "ai.paused": boolean;
  "automation.mode": "built-in" | "ai";
  /** Per-automation owner, keyed by automation id. Missing means "follow the mode". */
  "automation.overrides": Record<string, "built-in" | "ai" | "off">;
  "automation.aiCheckinWindowHours": number;
  "automation.lastAiCheckinAt": number;
  /** Folder naming for new shoots (see domain/folders.ts). */
  "folders.pattern": string;
  "folders.rawSubdir": string;
  "folders.deliverySubdir": string;
  /** Google Calendar (see google/). Client ID and secret are the studio's own OAuth client. */
  "google.clientId": string;
  "google.clientSecret": string; // secret
  "google.refreshToken": string; // secret
  "google.email": string;
  "google.studioCalendarId": string;
  "google.oauthState": string;
  "google.needsReconnect": boolean;
  "google.lastSyncAt": number;
  "google.lastError": string;
  /** Outgoing email (SMTP). The password is the studio's own, encrypted at rest. */
  "email.host": string;
  "email.port": number;
  "email.security": "none" | "starttls" | "tls";
  "email.user": string;
  "email.password": string; // secret
  "email.fromName": string;
  "email.fromAddress": string;
  "email.replyTo": string;
  /** The public inquiry form (see domain/inquiry.ts). */
  "inquiry.enabled": boolean;
  "inquiry.intro": string;
  "inquiry.thanks": string;
  "inquiry.notify": boolean;
  /** Camera upload server (see upload/). The ports come from the environment; these are the studio's choices. */
  "upload.protocol": "sftp" | "ftp" | "ftps";
  "upload.mode": "on_demand" | "scheduled" | "always_on";
  /** On-demand mode closes after this many minutes with no camera or live-view activity. */
  "upload.idleMinutes": number;
  "upload.schedule": import("./upload/schedule.js").ScheduleWindow[];
  /** Files sent to a camera's top-level folder are filed into a dated subfolder. */
  "upload.sortByDay": boolean;
  /** The address FTP cameras connect back to for data, normally the server's LAN address. */
  "upload.passiveHost": string;
}

const SECRET_KEYS = new Set<keyof SettingTypes>(["tunnel.token", "google.clientSecret", "google.refreshToken", "email.password"]);

export class Settings {
  constructor(
    private readonly db: Db,
    private readonly secrets: Secrets,
  ) {}

  get<K extends keyof SettingTypes>(key: K): SettingTypes[K] | undefined {
    const row = this.db.select().from(tables.setting).where(eq(tables.setting.key, key)).get();
    if (!row) return undefined;
    if (SECRET_KEYS.has(key)) return this.secrets.decrypt(row.value as string) as SettingTypes[K];
    return row.value as SettingTypes[K];
  }

  set<K extends keyof SettingTypes>(key: K, value: SettingTypes[K]): void {
    const stored = SECRET_KEYS.has(key) ? this.secrets.encrypt(String(value)) : value;
    this.db
      .insert(tables.setting)
      .values({ key, value: stored as unknown, updatedAt: new Date() })
      .onConflictDoUpdate({ target: tables.setting.key, set: { value: stored as unknown, updatedAt: new Date() } })
      .run();
  }

  delete(key: keyof SettingTypes): void {
    this.db.delete(tables.setting).where(eq(tables.setting.key, key)).run();
  }
}
