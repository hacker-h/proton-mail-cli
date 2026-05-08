#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ProtonMailBrowserClient, defaultSessionFile } from "../src/index.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node scripts/capture-session.mjs [options]

Options:
  --session-file <path>   Session JSON path (default: data/protonmail-auth.json)
  --profile-dir <path>    Persistent Chromium profile directory
  --timeout <seconds>     Manual completion timeout (default: 1800)
  --repo <owner/name>     GitHub repo for --set-secret
  --set-secret            Store captured session as PROTONMAIL_SESSION_JSON
  --json                  Print safe JSON result
  --help, -h              Show this help

Environment:
  PROTONMAIL_USERNAME     Proton test account username
  PROTONMAIL_PASSWORD     Proton test account password
`);
  process.exit(0);
}

const sessionFile = path.resolve(getArg("--session-file") || process.env.PROTONMAIL_SESSION_FILE || defaultSessionFile());
const profileDir = getArg("--profile-dir") || process.env.PROTONMAIL_DEBUG_PROFILE_DIR || path.resolve("data", "debug-profile");
const timeoutSeconds = Number(getArg("--timeout") || 1800);
const shouldSetSecret = args.includes("--set-secret");
const jsonOutput = args.includes("--json");

const client = new ProtonMailBrowserClient({
  sessionFile,
  manualLoginTimeoutSeconds: timeoutSeconds,
  debug: {
    profileDir,
    persistProfile: true,
    suppressCooldown: true,
  },
});

const result = await client.loginAndSaveSession({
  headless: false,
  manualFallback: true,
  timeoutSeconds,
});

await result.context?.close().catch(() => {});
await result.browser?.close().catch(() => {});

const safeResult = {
  success: Boolean(result.success),
  loginMethod: result.loginMethod || "",
  sessionValid: Boolean(result.sessionValid),
  sessionFile,
  profileDir,
  error: result.error || "",
};

if (!result.success) {
  output(safeResult);
  process.exit(1);
}

if (shouldSetSecret) {
  const repo = getArg("--repo") || process.env.GITHUB_REPOSITORY || detectRepo();
  if (!repo) {
    output({ ...safeResult, error: "Unable to determine GitHub repo for --set-secret" });
    process.exit(1);
  }

  const secretResult = spawnSync("gh", ["secret", "set", "PROTONMAIL_SESSION_JSON", "-R", repo], {
    input: readSessionFile(sessionFile),
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (secretResult.status !== 0) {
    output({ ...safeResult, error: (secretResult.stderr || secretResult.stdout || "gh secret set failed").trim() });
    process.exit(1);
  }

  safeResult.secretUpdated = true;
}

output(safeResult);

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

function readSessionFile(filePath) {
  return JSON.stringify(minimizeSessionForSecret(JSON.parse(readTextFile(filePath))));
}

function minimizeSessionForSecret(storageState) {
  return {
    cookies: storageState.cookies || [],
    origins: (storageState.origins || []).filter((origin) => origin.origin === "https://account.proton.me"),
  };
}

function readTextFile(filePath) {
  return readFileSync(filePath, "utf8");
}

function output(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    console.log(`Session captured at ${result.sessionFile}`);
    if (result.secretUpdated) {
      console.log("Updated PROTONMAIL_SESSION_JSON GitHub secret.");
    }
  } else {
    console.error(result.error || "Session capture failed");
  }
}
