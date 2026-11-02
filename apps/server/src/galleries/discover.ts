import path from "node:path";
import { isIgnoredName, isImageFile, readDirSafe, toRel } from "./files.js";

export interface FolderRules {
  /** Delivery folder name inside a shoot folder (default "Gallery"). */
  deliveryFolder: string;
  /** Shoot subfolders that are never read (default ["Originals"]). */
  privateFolders: string[];
}

export const DEFAULT_RULES: FolderRules = { deliveryFolder: "Gallery", privateFolders: ["Originals"] };

/** A folder on the share that holds a gallery's worth of photos. */
export interface Candidate {
  /** The match target: the shoot folder (relative to the share root). */
  shootFolder: string;
  /** Where the photos are read from: the delivery folder, or the shoot folder itself when there is none. */
  root: string;
}

const MAX_DEPTH = 8;
const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const YEARISH = /^(19|20)\d{2}$/;

/**
 * Finds gallery candidates under the share root (docs/GALLERIES.md section 2):
 * - a folder with a delivery subfolder (`Gallery/`) is a shoot folder, and the delivery folder is its gallery root;
 * - a hand-made folder of images is its own gallery, and its image subfolders become sets;
 * - private shoot subfolders (`Originals/`) and ignored names are never entered.
 */
export function discover(shareRoot: string, rules: FolderRules = DEFAULT_RULES): Candidate[] {
  const found = new Map<string, Candidate>();

  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const entries = readDirSafe(dir);
    const subdirs = entries.filter((e) => e.isDirectory() && !isIgnoredName(e.name));
    const delivery = subdirs.find((d) => same(d.name, rules.deliveryFolder));
    const rel = toRel(shareRoot, dir);

    if (delivery && rel !== "") {
      found.set(rel, { shootFolder: rel, root: toRel(shareRoot, path.join(dir, delivery.name)) });
      return; // nothing else inside a shoot folder is a gallery
    }

    const hasImages = entries.some((e) => e.isFile() && isImageFile(e.name));
    if (hasImages && rel !== "") {
      const parent = path.dirname(dir);
      const parentRel = toRel(shareRoot, parent);
      // A folder of images inside a hand-made gallery folder is a set of that gallery, unless
      // the parent is the share root or a year folder (then each image folder is its own gallery).
      const parentIsGallery = parentRel !== "" && !YEARISH.test(path.basename(parent)) && !found.has(rel);
      if (parentIsGallery && found.has(parentRel)) return;
      if (parentIsGallery && siblingsAllSets(parent, rules)) {
        found.set(parentRel, { shootFolder: parentRel, root: parentRel });
        return;
      }
      found.set(rel, { shootFolder: rel, root: rel });
      return;
    }

    for (const d of subdirs) {
      if (rules.privateFolders.some((p) => same(p, d.name))) continue;
      walk(path.join(dir, d.name), depth + 1);
    }
  };

  walk(shareRoot, 0);
  return [...found.values()].sort((a, b) => a.shootFolder.localeCompare(b.shootFolder));
}

/** True when a folder has no images of its own but at least two subfolders that do (Highlights/, Full Gallery/). */
function siblingsAllSets(parent: string, rules: FolderRules): boolean {
  const entries = readDirSafe(parent);
  if (entries.some((e) => e.isFile() && isImageFile(e.name))) return true;
  const imageDirs = entries.filter(
    (e) => e.isDirectory() && !isIgnoredName(e.name) && !rules.privateFolders.some((p) => same(p, e.name)) && readDirSafe(path.join(parent, e.name)).some((f) => f.isFile() && isImageFile(f.name)),
  );
  return imageDirs.length >= 2;
}

/** The sets inside a gallery root: one per subfolder (deeper folders flatten into it), plus "" for loose files. */
export function listGalleryFiles(shareRoot: string, root: string): Map<string, string[]> {
  const abs = path.join(shareRoot, root);
  const sets = new Map<string, string[]>();
  const collect = (dir: string, depth: number, out: string[]) => {
    for (const e of readDirSafe(dir)) {
      if (e.isDirectory() && isIgnoredName(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isFile() && isImageFile(e.name)) out.push(toRel(shareRoot, p));
      else if (e.isDirectory() && depth < 4) collect(p, depth + 1, out);
    }
  };
  const loose: string[] = [];
  for (const e of readDirSafe(abs)) {
    if (e.isDirectory() && isIgnoredName(e.name)) continue;
    const p = path.join(abs, e.name);
    if (e.isFile() && isImageFile(e.name)) loose.push(toRel(shareRoot, p));
    else if (e.isDirectory()) {
      const files: string[] = [];
      collect(p, 1, files);
      if (files.length) sets.set(e.name, files);
    }
  }
  if (loose.length) sets.set("", loose);
  return sets;
}
