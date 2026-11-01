import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The instance key lives in /config/secret.key, created on first run.
 * It encrypts secrets stored in the database (tunnel token, PayPal and Google credentials).
 */
export class Secrets {
  private constructor(private readonly key: Buffer) {}

  static load(configDir: string): Secrets {
    const file = path.join(configDir, "secret.key");
    fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    }
    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${file} is not a valid key. Restore it from a backup, or delete it to start fresh (stored secrets will need re-entering).`);
    return new Secrets(key);
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  }

  decrypt(box: string): string {
    const [v, iv, tag, data] = box.split(".");
    if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognized secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }

  /** Stable per-install identifier derived from the key (never reveals the key). */
  instanceId(): string {
    return crypto.createHmac("sha256", this.key).update("instance-id").digest("hex").slice(0, 16);
  }
}
