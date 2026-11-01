import { count } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";
import { newId } from "./context.js";

const STAGES = [
  { name: "New inquiry", kind: "open" },
  { name: "In conversation", kind: "open" },
  { name: "Quote sent", kind: "open" },
  { name: "Booked", kind: "won" },
  { name: "Lost", kind: "lost" },
] as const;

const SHOOT_TYPES = ["Portrait", "Headshot", "Family", "Wedding", "Newborn", "Event", "Lifestyle", "Commercial"];

/** Gives a fresh studio sensible lead stages and shoot types to start from. Safe to run on every start. */
export function ensureDefaults(db: Db): void {
  db.transaction((tx) => {
    if ((tx.select({ n: count() }).from(tables.leadStage).get()?.n ?? 0) === 0) {
      tx.insert(tables.leadStage)
        .values(STAGES.map((s, i) => ({ id: newId(), name: s.name, kind: s.kind, position: i })))
        .run();
    }
    if ((tx.select({ n: count() }).from(tables.shootType).get()?.n ?? 0) === 0) {
      tx.insert(tables.shootType)
        .values(SHOOT_TYPES.map((name, i) => ({ id: newId(), name, folderLabel: name, position: i })))
        .run();
    }
  });
}
