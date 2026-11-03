import { and, eq, sql } from "drizzle-orm";
import { tables, type Db } from "@openportrait/db";

const { downloadEvent } = tables;
type Gallery = typeof tables.gallery.$inferSelect;

export interface Allowance {
  /** Caps the studio set; null means no cap. */
  maxTimes: number | null;
  maxFiles: number | null;
  /** What this client has used so far. */
  usedTimes: number;
  usedFiles: number;
  /** What is left; null means unlimited. */
  timesLeft: number | null;
  filesLeft: number | null;
}

/** Downloads are counted per client, by the email they gave. Staff previewing a gallery are never counted. */
export function allowanceFor(db: Db, g: Gallery, email: string | null): Allowance {
  const maxTimes = g.downloadMaxTimes ?? null;
  const maxFiles = g.downloadMaxFiles ?? null;
  let usedTimes = 0;
  let usedFiles = 0;
  if ((maxTimes !== null || maxFiles !== null) && email) {
    const row = db
      .select({ n: sql<number>`count(*)`, files: sql<number>`coalesce(sum(${downloadEvent.fileCount}), 0)` })
      .from(downloadEvent)
      .where(and(eq(downloadEvent.galleryId, g.id), sql`lower(${downloadEvent.clientEmail}) = ${email.toLowerCase()}`))
      .get();
    usedTimes = Number(row?.n ?? 0);
    usedFiles = Number(row?.files ?? 0);
  }
  return {
    maxTimes,
    maxFiles,
    usedTimes,
    usedFiles,
    timesLeft: maxTimes === null ? null : Math.max(0, maxTimes - usedTimes),
    filesLeft: maxFiles === null ? null : Math.max(0, maxFiles - usedFiles),
  };
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** Why a download of `count` files is refused, in words the client can act on; null when it is allowed. */
export function limitMessage(a: Allowance, count: number): string | null {
  if (a.timesLeft !== null && a.timesLeft < 1) return `You've used all ${a.maxTimes} of your downloads for this gallery. Contact the studio if you need more.`;
  if (a.filesLeft !== null && a.filesLeft < 1) return `You've downloaded the ${files(a.maxFiles!)} included with this gallery. Contact the studio if you need more.`;
  if (a.filesLeft !== null && count > a.filesLeft) return `This download has ${files(count)}, but you have ${files(a.filesLeft)} left. Choose a smaller set or single photos.`;
  return null;
}
