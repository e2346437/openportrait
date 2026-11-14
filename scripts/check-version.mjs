#!/usr/bin/env node
// One version number per release. The root package.json is the source; every
// workspace package must carry the same version, and a release tag such as v0.1.0
// must match it. Usage: node scripts/check-version.mjs [tag]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const root = read("package.json").version;

const files = ["package.json"];
for (const group of ["apps", "packages"]) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group)) {
    const file = join(group, name, "package.json");
    if (existsSync(file)) files.push(file);
  }
}

const problems = [];
for (const file of files) {
  const version = read(file).version;
  if (version !== root) problems.push(`${file} is ${version}, but the root version is ${root}`);
}

const tag = process.argv[2];
if (tag !== undefined && tag.replace(/^v/, "") !== root) {
  problems.push(`tag ${tag} does not match the root version ${root}`);
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`version ${root} in ${files.length} packages${tag ? `, matches ${tag}` : ""}`);
