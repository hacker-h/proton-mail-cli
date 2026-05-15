#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CHECKSUM_FILE = "SHA256SUMS";

export function writeSha256Sums(directory) {
  const files = releaseFiles(directory);
  assert.ok(files.length > 0, `No release artifacts found in ${directory}`);
  const lines = files.map((fileName) => `${sha256File(path.join(directory, fileName))}  ${fileName}`);
  const checksumPath = path.join(directory, CHECKSUM_FILE);
  fs.writeFileSync(checksumPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
  return checksumPath;
}

export function verifySha256Sums(directory, requiredFiles = []) {
  const checksumPath = path.join(directory, CHECKSUM_FILE);
  assert.ok(fs.existsSync(checksumPath), `Missing ${CHECKSUM_FILE} in ${directory}`);
  const entries = parseSha256Sums(fs.readFileSync(checksumPath, "utf8"));
  const byFile = new Map(entries.map((entry) => [entry.fileName, entry.hash]));

  for (const fileName of requiredFiles) {
    assert.ok(byFile.has(fileName), `${CHECKSUM_FILE} does not contain ${fileName}`);
  }

  for (const { fileName, hash } of entries) {
    assert.ok(!path.isAbsolute(fileName) && !fileName.includes(".."), `${CHECKSUM_FILE} contains unsafe path ${fileName}`);
    const artifactPath = path.join(directory, fileName);
    assert.ok(fs.existsSync(artifactPath), `${CHECKSUM_FILE} references missing artifact ${fileName}`);
    const actual = sha256File(artifactPath);
    assert.equal(actual, hash, `Checksum mismatch for ${fileName}: expected ${hash}, got ${actual}`);
  }
}

export function parseSha256Sums(content) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line);
      assert.ok(match, `Invalid ${CHECKSUM_FILE} line: ${line}`);
      return { hash: match[1].toLowerCase(), fileName: match[2] };
    });
}

function releaseFiles(directory) {
  return fs.readdirSync(directory)
    .filter((fileName) => fileName !== CHECKSUM_FILE)
    .filter((fileName) => fs.statSync(path.join(directory, fileName)).isFile())
    .sort((a, b) => a.localeCompare(b));
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, directory = "release", ...requiredFiles] = process.argv.slice(2);
  if (command === "write") {
    const checksumPath = writeSha256Sums(directory);
    console.log(`Wrote ${checksumPath}`);
  } else if (command === "verify") {
    verifySha256Sums(directory, requiredFiles);
    console.log(`OK: verified ${path.join(directory, CHECKSUM_FILE)}`);
  } else {
    console.error("Usage: node scripts/release-checksums.mjs <write|verify> [directory] [required-file ...]");
    process.exit(1);
  }
}
