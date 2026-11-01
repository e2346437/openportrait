import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanSubdir, createShootFolder, dateParts, DEFAULT_FOLDER_PATTERN, renderFolder, resolveInside, safeSegment, unknownTokens, uniqueFolder } from "../src/domain/folders.js";

describe("folder names", () => {
  it("renders the default pattern from subject, date and type", () => {
    expect(renderFolder(DEFAULT_FOLDER_PATTERN, { year: "2026", date: "2026-11-14", type: "Headshot", subject: "Jane Smith" })).toBe("2026/2026-11-14 Headshot - Jane Smith");
  });

  it("makes names safe for Windows, macOS and SMB", () => {
    expect(safeSegment('Jane: "the" boss?')).toBe("Jane- -the- boss-");
    expect(safeSegment("Emma & Liam...  ")).toBe("Emma & Liam");
    expect(safeSegment("CON")).toBe("CON_");
    expect(safeSegment("../../etc")).toBe("-..-etc");
  });

  it("never lets a token add folders", () => {
    expect(renderFolder("{year}/{subject}", { year: "2026", subject: "a/b\\c" })).toBe("2026/a-b-c");
    expect(renderFolder("{subject}", { subject: ".." })).toBeNull();
  });

  it("tidies what an empty token leaves behind", () => {
    expect(renderFolder("{date} {type} - {location}", { date: "2026-11-14", type: "Wedding" })).toBe("2026-11-14 Wedding");
    expect(renderFolder("{date} {type} ({location})", { date: "2026-11-14", type: "Wedding" })).toBe("2026-11-14 Wedding");
    expect(renderFolder("{type} - {subject}", { subject: "Jane" })).toBe("Jane");
  });

  it("flags unknown tokens", () => {
    expect(unknownTokens("{year}/{date} {typ} - {subjet}")).toEqual(["typ", "subjet"]);
    expect(unknownTokens(DEFAULT_FOLDER_PATTERN)).toEqual([]);
  });

  it("reads the date in the studio's time zone", () => {
    const lateEvening = new Date("2026-11-15T03:30:00Z");
    expect(dateParts(lateEvening, "America/Chicago").date).toBe("2026-11-14");
    expect(dateParts(lateEvening, "UTC").date).toBe("2026-11-15");
  });

  it("adds a suffix when a folder is taken", () => {
    const taken = new Set(["a", "a (2)"]);
    expect(uniqueFolder("a", (c) => taken.has(c))).toBe("a (3)");
    expect(uniqueFolder("b", (c) => taken.has(c))).toBe("b");
  });

  it("keeps subfolders inside the shoot folder", () => {
    expect(cleanSubdir("Originals/RAW")).toBe("Originals/RAW");
    expect(cleanSubdir("../../x")).toBe("x");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-share-"));
    expect(() => resolveInside(root, "../escape")).toThrow();
    createShootFolder(root, "2026/x", ["Originals/RAW", "Gallery"]);
    expect(fs.existsSync(path.join(root, "2026/x/Originals/RAW"))).toBe(true);
    expect(fs.existsSync(path.join(root, "2026/x/Gallery"))).toBe(true);
  });
});
