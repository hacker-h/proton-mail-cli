#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const SCAN_DIRS = [
  ".github",
  "scripts",
  "src",
];

const SCAN_FILES = [
  "package.json",
];

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".sisyphus",
  "dist",
  "out",
  "release",
  "data",
]);

const VAR_RE = /\bPROTONMAIL_[A-Z0-9_]+\b/g;

const found = new Map(); // var -> Set<relativePath>

for (const dir of SCAN_DIRS) {
  walk(path.join(ROOT, dir));
}

for (const file of SCAN_FILES) {
  scanFile(path.join(ROOT, file));
}

const usedVars = [...found.keys()].sort();
const documentedVars = extractReadmeVars(path.join(ROOT, "README.md"));

const missingDocs = usedVars.filter((v) => !documentedVars.has(v));
const extraDocs = [...documentedVars].filter((v) => !found.has(v)).sort();

if (missingDocs.length) {
  console.error("Undocumented PROTONMAIL_* variables found in repo:\n");
  for (const v of missingDocs) {
    const paths = [...(found.get(v) || [])].sort().join(", ");
    console.error(`- ${v} (used in: ${paths})`);
  }
  console.error("\nAdd them to README.md under '## Environment Variables'.");
  process.exit(1);
}

console.log(`OK: all ${usedVars.length} PROTONMAIL_* variables are documented in README.md`);

if (extraDocs.length) {
  console.log("\nNote: README documents variables not currently used by the repo:");
  for (const v of extraDocs) {
    console.log(`- ${v}`);
  }
}

function walk(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (entry.name !== ".github") continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(fullPath);
      continue;
    }
    scanFile(fullPath);
  }
}

function scanFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  if (!fs.statSync(filePath).isFile()) return;
  const ext = path.extname(filePath).toLowerCase();
  const allowed =
    ext === ".js" ||
    ext === ".mjs" ||
    ext === ".cjs" ||
    ext === ".ts" ||
    ext === ".json" ||
    ext === ".md" ||
    ext === ".yml" ||
    ext === ".yaml";
  if (!allowed) return;

  const raw = fs.readFileSync(filePath, "utf8");
  const matches = raw.match(VAR_RE);
  if (!matches) return;

  const rel = path.relative(ROOT, filePath);
  for (const v of matches) {
    if (!found.has(v)) found.set(v, new Set());
    found.get(v).add(rel);
  }
}

function extractReadmeVars(readmePath) {
  const raw = fs.readFileSync(readmePath, "utf8");
  const sectionStart = raw.indexOf("\n## Environment Variables");
  if (sectionStart === -1) {
    return new Set();
  }
  const rest = raw.slice(sectionStart);
  const nextHeader = rest.slice(1).search(/\n##\s+/);
  const section = nextHeader === -1 ? rest : rest.slice(0, nextHeader + 1);

  const vars = new Set();
  for (const m of section.matchAll(/`(PROTONMAIL_[A-Z0-9_]+)`/g)) {
    vars.add(m[1]);
  }
  return vars;
}
