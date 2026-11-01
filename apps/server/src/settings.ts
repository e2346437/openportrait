import { eq } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import type { Secrets } from "./secrets.js";

/** Every setting the app knows, with its type. Secrets are encrypted at rest. */
export interface SettingTypes {
  "setup.completedAt": number;
  "studio.name": string;
  "studio.email": string;
  "studio.timezone": string;
  "internet.publicUrl": string;
  "internet.trustCloudflare": boolean;
  "tunnel.token": string; // secret
  "backup.lastAt": number;
  /** Folder naming for new shoots (see domain/folders.ts). */
  "folders.pattern": string;
  "folders.rawSubdir": string;
  "folders.deliverySubdir": string;
}

const SECRET_KEYS = new Set<keyof SettingTypes>(["tunnel.token"]);

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
