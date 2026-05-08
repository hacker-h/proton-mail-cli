#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultSessionFile } from "../src/index.js";

const args = process.argv.slice(2);
const sessionFile = path.resolve(getArg("--session-file") || process.env.PROTONMAIL_SESSION_FILE || defaultSessionFile());
const repo = getArg("--repo") || process.env.GITHUB_REPOSITORY || detectRepo();

if (!repo) {
  fail("Unable to determine GitHub repo. Pass --repo owner/name or set GITHUB_REPOSITORY.");
}

if (!fs.existsSync(sessionFile)) {
  fail(`Session file not found: ${sessionFile}`);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
} catch {
  fail(`Session file is not valid JSON: ${sessionFile}`);
}

if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
  fail("Session file does not contain browser cookies.");
}

const result = spawnSync("gh", ["secret", "set", "PROTONMAIL_SESSION_JSON", "-R", repo], {
  input: JSON.stringify(minimizeSessionForSecret(parsed)),
  stdio: ["pipe", "pipe", "pipe"],
  encoding: "utf8",
});

if (result.status !== 0) {
  fail((result.stderr || result.stdout || "gh secret set failed").trim());
}

console.log(`Stored PROTONMAIL_SESSION_JSON for ${repo}.`);
console.log("Session contents were not printed.");

function minimizeSessionForSecret(storageState) {
  return {
    cookies: storageState.cookies || [],
    origins: (storageState.origins || []).filter((origin) => origin.origin === "https://account.proton.me"),
  };
}

function getArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function detectRepo() {
  const result = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
