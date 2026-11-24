import { eq } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import type { WatermarkSpec } from "./galleries/watermark.js";
import type { Secrets } from "./secrets.js";

export interface StudioAddress {
  street: string;
  unit: string;
  city: string;
  state: string;
  postal: string;
}
export interface StudioDayHours {
  open: boolean;
  from: string;
  to: string;
}
export interface StudioHours {
  /** Monday first. Seven entries. */
  days: StudioDayHours[];
  note: string;
}

/** Every setting the app knows, with its type. Secrets are encrypted at rest. */
export interface SettingTypes {
  "setup.completedAt": number;
  "studio.name": string;
  "studio.email": string;
  "studio.timezone": string;
  "studio.phone": string;
  "studio.website": string;
  "studio.physicalAddress": StudioAddress;
  /** Null means "same as the physical address". */
  "studio.mailingAddress": StudioAddress | null;
  "studio.showAddress": boolean;
  /** Null means hours are not shown. */
  "studio.hours": StudioHours | null;
  /** Set when a logo has been uploaded; changes with each upload. */
  "studio.logoVersion": number;
  /** Set when a sign-in photo has been uploaded; changes with each upload. */
  "studio.signInPhotoVersion": number;
  "internet.publicUrl": string;
  "internet.trustCloudflare": boolean;
  /** The server's address on the home network (host IP and the port mapped to the container). */
  "internet.lanUrl": string;
  "tunnel.token": string; // secret
  "backup.lastAt": number;
  "backup.enabled": boolean;
  /** Hours between scheduled backups. */
  "backup.everyHours": number;
  /** Scheduled backups kept; the oldest are removed. */
  "backup.keep": number;
  "backup.includeGalleries": boolean;
  "backup.includeOriginals": boolean;
  /** JSON list of places backups are copied to (see backup-destinations.ts). Encrypted, because a destination may hold credentials. */
  "backup.destinations": string;
  /** Delivery folder inside each shoot folder; its subfolders are gallery sets. */
  "galleries.deliveryFolder": string;
  /** Other shoot subfolders the gallery watcher never reads (camera originals). */
  "galleries.privateFolders": string[];
  /** Download lock the publish dialog starts on (docs/GALLERIES.md section 6.4). */
  /** Wording laid over previews of payment-locked photos. Empty means the studio name. */
  "galleries.watermarkText": string;
  /** How the watermark looks (see galleries/watermark.ts). Missing means the defaults. */
  "galleries.watermark": Partial<WatermarkSpec>;
  /** Studio default for Protected Proofing (see galleries/proofing.ts). Missing means Balanced, only while downloads are locked. */
  "galleries.proofing": Partial<{ mode: "light" | "balanced" | "strong"; apply: "locked" | "always" | "off"; maxLongEdge: number | null }>;
  /** Set when a custom watermark image has been uploaded; changes with each upload. */
  "galleries.watermarkImageVersion": number;
  /** JPEG quality (60-100) of "web size" downloads. Missing means 88. */
  "galleries.webQuality": number;
  /** Months after first publish that a gallery expires and is archived. 0 means never. Missing means 12. Applies to galleries published after it is set. */
  "galleries.expiryMonths": number;
  /** Email the shoot's clients before a gallery expires. Missing means on. */
  "galleries.expiryReminders": boolean;
  "galleries.defaultDownloadLock": "until_paid" | "highlights_early" | "none";
  "ai.enabled": boolean;
  "ai.paused": boolean;
  /** Argon2 hash of the owner's authorization code for sensitive AI actions (see ai/authcode.ts). Empty means none set. */
  "ai.authCodeHash": string;
  "ai.authCodeSetAt": number;
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
  /** Quotes, invoices and payments. Amounts are whole cents in one currency. */
  "money.currency": string;
  /** Default sales tax in basis points (825 = 8.25%). */
  "money.taxBps": number;
  /** Places the studio collects tax, one of them the default (see domain/tax.ts). `money.taxBps` mirrors the default. */
  "money.taxRates": { id: string; state: string; name: string; rateBps: number; registration: string; isDefault: boolean }[];
  "money.terms": string;
  /** How to pay by hand (Venmo handle, check address). Shown on invoices. */
  "money.paymentInstructions": string;
  "money.quoteValidDays": number;
  /** PayPal Checkout. The studio's own app credentials; the secret is encrypted at rest. */
  "paypal.clientId": string;
  "paypal.clientSecret": string; // secret
  "paypal.mode": "sandbox" | "live";
  "paypal.webhookId": string;
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

const SECRET_KEYS = new Set<keyof SettingTypes>(["tunnel.token", "google.clientSecret", "google.refreshToken", "email.password", "paypal.clientSecret", "backup.destinations"]);

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
