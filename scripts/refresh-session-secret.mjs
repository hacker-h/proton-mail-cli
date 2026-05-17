#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProtonMailBrowserClient, defaultSessionFile } from "../src/index.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node scripts/refresh-session-secret.mjs [options]

Options:
  --session-file <path>   Temporary session JSON path
  --repo <owner/name>     GitHub repository to update
  --timeout <seconds>     Login timeout (default: 180)
  --json                  Print safe JSON result
  --help, -h              Show this help

Environment:
  PROTONMAIL_USERNAME     Proton test account username
  PROTONMAIL_PASSWORD     Proton test account password
  GH_TOKEN                Fine-scoped token that can update Actions secrets
`);
  process.exit(0);
}

const sessionFile = path.resolve(getArg("--session-file") || process.env.PROTONMAIL_SESSION_FILE || defaultSessionFile());
const repo = getArg("--repo") || process.env.GITHUB_REPOSITORY || detectRepo();
const timeoutSeconds = positiveInteger(getArg("--timeout"), 180);
const jsonOutput = args.includes("--json");

if (!repo) fail("Unable to determine GitHub repo. Pass --repo owner/name or set GITHUB_REPOSITORY.");
if (!process.env.PROTONMAIL_USERNAME || !process.env.PROTONMAIL_PASSWORD) fail("Missing PROTONMAIL_USERNAME or PROTONMAIL_PASSWORD for session refresh.");
if (!process.env.GH_TOKEN) fail("Missing GH_TOKEN with permission to update repository Actions secrets.");

fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

const client = new ProtonMailBrowserClient({
  headless: true,
  sessionFile,
  timeoutSeconds,
  manualLoginTimeoutSeconds: timeoutSeconds,
});

let login;
try {
  login = await client.loginAndSaveSession({
    headless: true,
    manualFallback: false,
    timeoutSeconds,
  });
} catch (error) {
  output({
    success: false,
    category: "selector_or_backend_drift",
    error: redact(error instanceof Error ? error.message : String(error)),
  });
  process.exit(1);
}

await login.context?.close().catch(() => {});
await login.browser?.close().catch(() => {});

if (!login.success || !login.sessionValid) {
  output({
    success: false,
    category: classifyLoginFailure(login),
    error: safeError(login),
  });
  process.exit(1);
}

const secretResult = spawnSync("gh", ["secret", "set", "PROTONMAIL_SESSION_JSON", "-R", repo], {
  input: readMinimizedSession(sessionFile),
  stdio: ["pipe", "pipe", "pipe"],
  encoding: "utf8",
});

if (secretResult.status !== 0) {
  output({
    success: false,
    category: "secret_update_failed",
    error: redact(secretResult.stderr || secretResult.stdout || "gh secret set failed"),
  });
  process.exit(1);
}

output({
  success: true,
  category: "refreshed",
  loginMethod: login.loginMethod || "credential",
  sessionValid: true,
  repo,
});

function getArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function detectRepo() {
  const result = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readMinimizedSession(filePath) {
  const storageState = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return JSON.stringify({
    cookies: storageState.cookies || [],
    origins: (storageState.origins || []).filter((origin) => origin.origin === "https://account.proton.me"),
  });
}

function classifyLoginFailure(result) {
  if (result?.captcha || result?.twoFactor || result?.manualRequired) return "auth_challenge";
  if (result?.cooldown) return "cooldown";
  return "selector_or_backend_drift";
}

function safeError(result) {
  if (result?.captcha || result?.twoFactor || result?.manualRequired) {
    return "Proton requires CAPTCHA, 2FA, or manual interaction. Use headful local capture instead.";
  }
  return redact(result?.error || "Session refresh failed.");
}

function redact(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]")
    .replace(/("?\b(?:password|token|cookie|session|authorization)\b"?\s*[:=]\s*)("?)[^,"}\s]+\2/giu, "$1$2[redacted]$2");
}

function output(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.success) {
    console.log(`Refreshed PROTONMAIL_SESSION_JSON for ${result.repo}.`);
    console.log("Session contents were not printed.");
  } else {
    console.error(`${result.category}: ${result.error}`);
  }
}

function fail(message) {
  output({ success: false, category: "configuration_error", error: message });
  process.exit(1);
}
