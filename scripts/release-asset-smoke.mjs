#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifySha256Sums } from "./release-checksums.mjs";

const repo = readFlag("--repo") || process.env.GITHUB_REPOSITORY || "hacker-h/proton-mail-cli";
const requestedTag = readFlag("--tag") || process.env.RELEASE_TAG || "latest";
const allowMissingChecksums = process.argv.includes("--allow-missing-checksums") || process.env.ALLOW_MISSING_CHECKSUMS === "1";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-release-asset-smoke-"));
const downloadDir = path.join(tempRoot, "release");
const appDir = path.join(tempRoot, "app");
const homeDir = path.join(tempRoot, "home");
fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

const tag = requestedTag === "latest" ? latestReleaseTag(repo) : requestedTag;
downloadReleaseAsset(repo, tag, downloadDir);

const tarballs = fs.readdirSync(downloadDir).filter((name) => /^proton-mail-cli-.+\.tgz$/u.test(name));
assert.equal(tarballs.length, 1, `Expected one proton-mail-cli release tarball for ${tag}, found: ${tarballs.join(", ") || "none"}`);
const tarball = path.join(downloadDir, tarballs[0]);
assert.notEqual(path.dirname(tarball), process.cwd(), "release smoke must use the downloaded GitHub Release asset, not a workspace tarball");
try {
  verifySha256Sums(downloadDir, [tarballs[0]]);
} catch (error) {
  if (!allowMissingChecksums) throw error;
  console.warn(`Warning: ${error instanceof Error ? error.message : String(error)}`);
}

const install = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: appDir });
assert.equal(install.status, 0, install.stderr);

const pm = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
assert.equal(fs.existsSync(pm), true, "installed package should expose node_modules/.bin/pm");

const env = isolatedEnv(homeDir);
const help = run(pm, ["--help"], { cwd: appDir, env });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:/u);
assert.match(help.stdout, /pm ls/u);

const version = run(pm, ["--version"], { cwd: appDir, env });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /^pm \d+\.\d+\.\d+/u);

const failure = run(pm, ["read", "msg1", "--json"], { cwd: appDir, env });
assert.equal(failure.status, 1, failure.stderr);
assert.equal(failure.stdout, "");
const envelope = JSON.parse(failure.stderr);
assert.equal(envelope.ok, false);
assert.equal(envelope.command, "mail:read");
assert.equal(envelope.error.code, "INVALID_MESSAGE_REF");
assert.equal(envelope.meta.envelope, "pm.v1");

const importCheck = run(process.execPath, [
  "--input-type=module",
  "--eval",
  "import { ProtonMailClient, ProtonMailBrowserClient, FileSessionStore, buildMailMetadataFilter } from 'proton-mail-cli'; console.log(`${typeof ProtonMailClient}:${typeof ProtonMailBrowserClient}:${typeof FileSessionStore}:${typeof buildMailMetadataFilter}`);",
], { cwd: appDir, env });
assert.equal(importCheck.status, 0, importCheck.stderr);
assert.equal(importCheck.stdout, "function:function:function:function\n");

console.log(`OK: ${tarballs[0]} from ${repo}@${tag} installs and exposes a working pm binary`);

function latestReleaseTag(repository) {
  const result = run("gh", ["release", "view", "--repo", repository, "--json", "tagName", "--jq", ".tagName"]);
  assert.equal(result.status, 0, result.stderr);
  const tagName = result.stdout.trim();
  assert.ok(tagName, "latest GitHub Release has no tagName");
  return tagName;
}

function downloadReleaseAsset(repository, tagName, destination) {
  const result = run("gh", ["release", "download", tagName, "--repo", repository, "--pattern", "proton-mail-cli-*.tgz", "--pattern", "SHA256SUMS", "--dir", destination, "--clobber"]);
  assert.equal(result.status, 0, result.stderr);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function isolatedEnv(homeDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PROTONMAIL_")) delete env[key];
  }
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  return env;
}
