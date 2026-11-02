#!/usr/bin/env node
/**
 * Maintenance commands, run inside the container:
 *   docker exec openportrait openportrait reset-password you@example.com
 *   docker exec openportrait openportrait disable-mfa you@example.com
 *   docker exec openportrait openportrait backup
 */
import crypto from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "@openportrait/config";
import { backupDatabase, openDatabase, tables } from "@openportrait/db";
import { hashPassword } from "./auth.js";

const [command, arg] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase({ file: path.join(config.configDir, "openportrait.db") });

async function main(): Promise<number> {
  switch (command) {
    case "reset-password": {
      const email = arg?.trim().toLowerCase();
      if (!email) {
        console.error("Usage: openportrait reset-password <email>");
        return 2;
      }
      const user = db.select().from(tables.user).where(eq(tables.user.email, email)).get();
      if (!user) {
        const all = db.select({ email: tables.user.email }).from(tables.user).all();
        console.error(`No account uses ${email}.${all.length ? ` Accounts: ${all.map((u) => u.email).join(", ")}` : ""}`);
        return 1;
      }
      const temp = crypto.randomBytes(9).toString("base64url");
      db.update(tables.user).set({ passwordHash: await hashPassword(temp) }).where(eq(tables.user.id, user.id)).run();
      db.delete(tables.session).where(eq(tables.session.userId, user.id)).run();
      db.insert(tables.auditLog).values({ userId: user.id, action: "auth.password_reset_cli" }).run();
      console.log(`Temporary password for ${email}: ${temp}`);
      console.log("Sign in with it, then change it under Settings → Your account.");
      return 0;
    }
    case "disable-mfa": {
      const email = arg?.trim().toLowerCase();
      if (!email) {
        console.error("Usage: openportrait disable-mfa <email>");
        return 2;
      }
      const user = db.select().from(tables.user).where(eq(tables.user.email, email)).get();
      if (!user) {
        console.error(`No account uses ${email}.`);
        return 1;
      }
      db.update(tables.user).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null }).where(eq(tables.user.id, user.id)).run();
      db.delete(tables.session).where(eq(tables.session.userId, user.id)).run();
      db.insert(tables.auditLog).values({ userId: user.id, action: "auth.mfa_reset_cli" }).run();
      console.log(`Two-step sign-in is off for ${email}. Sign in with the password, then turn it back on under Settings → Your account.`);
      return 0;
    }
    case "backup": {
      const dest = path.join(config.configDir, "backups", `openportrait-manual-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      await backupDatabase(db, dest);
      console.log(`Backup written to ${dest}`);
      return 0;
    }
    default:
      console.log("OpenPortrait maintenance commands:\n  reset-password <email>   Set a temporary password and sign the account out everywhere\n  disable-mfa <email>      Turn off two-step sign-in for an account (lost phone and recovery codes)\n  backup                   Write a database snapshot to /config/backups");
      return command ? 2 : 0;
  }
}

main()
  .then((code) => {
    db.$client.close();
    process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
