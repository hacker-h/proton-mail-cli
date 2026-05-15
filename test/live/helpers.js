import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileSessionStore, ProtonMailBrowserClient, ProtonMailClient } from "../../src/index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const liveEnabled = process.env.PROTONMAIL_LIVE_TEST === "1";
export const hasSeededSession = Boolean(process.env.PROTONMAIL_SESSION_JSON);
export const hasConfiguredSessionFile = Boolean(process.env.PROTONMAIL_LIVE_SESSION_FILE && fs.existsSync(process.env.PROTONMAIL_LIVE_SESSION_FILE));
export const hasCredentials = Boolean(process.env.PROTONMAIL_USERNAME && process.env.PROTONMAIL_PASSWORD);
export const freshLoginAllowed = process.env.PROTONMAIL_ALLOW_FRESH_LOGIN === "1";
export const hasBrowserAuth = liveEnabled && (hasSeededSession || hasConfiguredSessionFile || (hasCredentials && freshLoginAllowed));
export const hasRestSession = liveEnabled && Boolean(process.env.PROTONMAIL_REST_SESSION_FILE && fs.existsSync(process.env.PROTONMAIL_REST_SESSION_FILE));
export const browserTestOptions = hasBrowserAuth ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 with PROTONMAIL_SESSION_JSON, PROTONMAIL_LIVE_SESSION_FILE, or explicit fresh-login credentials" };
export const pureLoginTestOptions = liveEnabled && hasCredentials && freshLoginAllowed ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 and PROTONMAIL_ALLOW_FRESH_LOGIN=1 with credentials" };
export const restTestOptions = hasRestSession ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 and PROTONMAIL_REST_SESSION_FILE for REST-backed live tests" };
export const restMutationTestOptions = hasRestSession && process.env.PROTONMAIL_LIVE_REST_MUTATION === "1"
  ? {}
  : { skip: "Set PROTONMAIL_LIVE_TEST=1, PROTONMAIL_REST_SESSION_FILE, and PROTONMAIL_LIVE_REST_MUTATION=1 for reversible REST mutation tests" };

export function makeLivePrefix(scope = "live") {
  const runId = process.env.GITHUB_RUN_ID || process.env.PROTONMAIL_LIVE_RUN_ID || String(Date.now());
  const suffix = Math.random().toString(36).slice(2, 10);
  return `pm-${scope}-${runId}-${suffix}`;
}

export function assertLivePrefix(value, prefix) {
  assert.equal(typeof value, "string");
  assert.equal(typeof prefix, "string");
  assert.ok(prefix.startsWith("pm-"), "live prefixes must use the pm- namespace");
  assert.ok(value.includes(prefix), `refusing to touch non-test data: ${redact(value)}`);
}

export function prepareSessionFile({ seed = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-live-"));
  const configuredSessionFile = process.env.PROTONMAIL_LIVE_SESSION_FILE || "";
  const sessionFile = configuredSessionFile || path.join(tmpDir, "session.json");
  if (configuredSessionFile) {
    fs.mkdirSync(path.dirname(configuredSessionFile), { recursive: true });
  }

  if (seed && process.env.PROTONMAIL_SESSION_JSON && !fs.existsSync(sessionFile)) {
    fs.writeFileSync(sessionFile, process.env.PROTONMAIL_SESSION_JSON, { encoding: "utf8", mode: 0o600 });
  }

  return {
    sessionFile,
    tmpDir: configuredSessionFile ? "" : tmpDir,
  };
}

export function cleanupTmpDir(tmpDir) {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

export function createBrowserClient(sessionFile, options = {}) {
  const headless = process.env.PROTONMAIL_LIVE_HEADLESS !== "0";
  return new ProtonMailBrowserClient({
    headless,
    sessionFile,
    timeoutSeconds: 120,
    manualLoginTimeoutSeconds: 120,
    ...options,
  });
}

export async function loginAndAssertSession(client) {
  const headless = process.env.PROTONMAIL_LIVE_HEADLESS !== "0";
  const login = await client.loginAndSaveSession({
    headless,
    manualFallback: false,
    timeoutSeconds: 120,
  });

  assert.equal(login.success, true, formatLiveFailure(login));
  assert.equal(login.sessionValid, true);
  if ((hasSeededSession || hasConfiguredSessionFile) && !freshLoginAllowed) {
    assert.equal(login.loginMethod, "session", "Seeded CI sessions must be reused without credential login");
  }
  return login;
}

export function createRestClient() {
  assert.ok(process.env.PROTONMAIL_REST_SESSION_FILE, "PROTONMAIL_REST_SESSION_FILE is required");
  return new ProtonMailClient({
    sessionStore: new FileSessionStore(process.env.PROTONMAIL_REST_SESSION_FILE),
    timeoutMs: 120_000,
  });
}

export function runPmJson(args, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  if (!mergedEnv.PROTONMAIL_SESSION_FILE) {
    mergedEnv.PROTONMAIL_SESSION_FILE = mergedEnv.PROTONMAIL_LIVE_SESSION_FILE || process.env.PROTONMAIL_LIVE_SESSION_FILE || process.env.PROTONMAIL_SESSION_FILE || "";
  }
  const result = spawnSync(process.execPath, ["bin/pm.js", ...args, "--json", "--timeout", "120"], {
    cwd: ROOT,
    env: mergedEnv,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  assert.equal(result.status, 0, redact(output || `pm exited ${result.status}`));
  return JSON.parse(result.stdout);
}

export function formatLiveFailure(result) {
  return JSON.stringify({
    category: classifyFailure(result),
    error: redact(result?.error || "Proton live check failed"),
    captcha: Boolean(result?.captcha),
    twoFactor: Boolean(result?.twoFactor),
    cooldown: Boolean(result?.cooldown),
    manualRequired: Boolean(result?.manualRequired),
    sessionValid: Boolean(result?.sessionValid),
  });
}

export function redact(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]")
    .replace(/(password|token|cookie|session|authorization)[^\n\r]*/giu, "$1=[redacted]");
}

function classifyFailure(result) {
  if (result?.captcha || result?.twoFactor || result?.manualRequired) return "auth_challenge";
  if (result?.cooldown) return "cooldown";
  return "project_or_proton_drift";
}
