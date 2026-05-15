import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { performLogin } from "../../src/browser-auth.js";
import { navigateToInbox } from "../../src/browser-client.js";
import { dismissModals } from "../../src/browser-selectors.js";
import { FileSessionStore, ProtonMailBrowserClient, ProtonMailClient } from "../../src/index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const liveEnabled = process.env.PROTONMAIL_LIVE_TEST === "1";
export const hasSeededSession = Boolean(process.env.PROTONMAIL_SESSION_JSON);
export const hasConfiguredSessionFile = Boolean(process.env.PROTONMAIL_LIVE_SESSION_FILE && fs.existsSync(process.env.PROTONMAIL_LIVE_SESSION_FILE));
export const hasCredentials = Boolean(process.env.PROTONMAIL_USERNAME && process.env.PROTONMAIL_PASSWORD);
export const hasSecondaryCredentials = Boolean(process.env.PROTONMAIL_USERNAME2 && process.env.PROTONMAIL_PASSWORD2);
export const freshLoginAllowed = process.env.PROTONMAIL_ALLOW_FRESH_LOGIN === "1";
export const hasBrowserAuth = liveEnabled && (hasSeededSession || hasConfiguredSessionFile || (hasCredentials && freshLoginAllowed));
export const hasRestSession = liveEnabled && Boolean(process.env.PROTONMAIL_REST_SESSION_FILE && fs.existsSync(process.env.PROTONMAIL_REST_SESSION_FILE));
export const browserTestOptions = hasBrowserAuth ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 with PROTONMAIL_SESSION_JSON, PROTONMAIL_LIVE_SESSION_FILE, or explicit fresh-login credentials" };
export const pureLoginTestOptions = liveEnabled && hasCredentials && freshLoginAllowed ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 and PROTONMAIL_ALLOW_FRESH_LOGIN=1 with credentials" };
export const secondaryLoginTestOptions = liveEnabled && hasSecondaryCredentials && freshLoginAllowed ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 and PROTONMAIL_ALLOW_FRESH_LOGIN=1 with PROTONMAIL_USERNAME2/PROTONMAIL_PASSWORD2" };
export const twoAccountTestOptions = liveEnabled && hasCredentials && hasSecondaryCredentials && freshLoginAllowed ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1, PROTONMAIL_ALLOW_FRESH_LOGIN=1, and both Proton test accounts" };
export const restTestOptions = hasRestSession ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 and PROTONMAIL_REST_SESSION_FILE for REST-backed live tests" };

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

export async function openLiveInboxPage({ sessionFile, usernameEnv = "PROTONMAIL_USERNAME", passwordEnv = "PROTONMAIL_PASSWORD" } = {}) {
  const headless = process.env.PROTONMAIL_LIVE_HEADLESS !== "0";
  const browser = await chromium.launch({ headless, args: ["--disable-blink-features=AutomationControlled"] });
  const storageState = sessionFile && fs.existsSync(sessionFile) ? sessionFile : undefined;
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    storageState,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => undefined });
  });
  const page = await context.newPage();
  let navigation = await navigateToInbox(page);
  if (navigation.state !== "inbox") {
    const login = await performLogin({
      page,
      context,
      username: process.env[usernameEnv] || "",
      password: process.env[passwordEnv] || "",
      sessionFile: sessionFile || path.join(os.tmpdir(), `protonmail-live-${usernameEnv}.json`),
      suppressCooldown: true,
    });
    assert.equal(login.success, true, formatLiveFailure(login));
    navigation = await navigateToInbox(page);
  }
  assert.equal(navigation.state, "inbox", redact(JSON.stringify(navigation)));
  await dismissModals(page);
  return { browser, context, page };
}

export async function closeLivePage(runtime) {
  await runtime?.context?.close().catch(() => {});
  await runtime?.browser?.close().catch(() => {});
}

export async function sendBrowserMessage(page, { to = [], cc = [], bcc = [], subject, body }) {
  assert.ok(to.length > 0, "at least one To recipient is required");
  await dismissModals(page);
  await page.locator('[data-testid="sidebar:compose"]').click({ force: true, timeout: 30000 });
  await page.locator('[data-testid="composer:to"]').waitFor({ state: "visible", timeout: 15000 });

  for (const address of to) await fillRecipient(page, "composer:to", address);
  if (cc.length > 0) {
    await page.locator('[data-testid="composer:recipients:cc-button"]').click();
    for (const address of cc) await fillRecipient(page, "composer:to-cc", address);
  }
  if (bcc.length > 0) {
    await page.locator('[data-testid="composer:recipients:bcc-button"]').click();
    for (const address of bcc) await fillRecipient(page, "composer:to-bcc", address);
  }

  await page.locator('[data-testid="composer:subject"]').fill(subject);
  await fillComposerBody(page, body);
  await page.locator('[data-testid="composer:send-button"]').click({ timeout: 15000 });
  await page.locator('[data-testid="composer:send-button"]').waitFor({ state: "detached", timeout: 45000 }).catch(async () => {
    await page.waitForTimeout(5000);
  });
}

export async function pollBrowserMessage({ sessionFile, usernameEnv, passwordEnv, subject, bodyText, timeoutMs = 120_000 }) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    const client = createBrowserClient(sessionFile, { usernameEnv, passwordEnv });
    const result = await client.getLatestMessage({ matchText: subject, timeoutSeconds: 120 });
    const subjectMatched = result.message?.subject === subject || String(result.message?.preview || "").includes(subject);
    if (result.success && subjectMatched && result.message?.bodyText?.includes(bodyText)) return result.message;
    lastError = String(result.error || "message not found yet");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  assert.fail(`Timed out waiting for ${redact(subject)}: ${redact(lastError)}`);
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

async function fillRecipient(page, testId, address) {
  const locator = page.locator(`[data-testid="${testId}"]`).last();
  await locator.fill(address);
  await locator.press("Enter");
}

async function fillComposerBody(page, body) {
  for (const frame of page.frames().reverse()) {
    const text = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (!text.includes("Gesendet mit Proton Mail") && !text.includes("Sent with Proton Mail")) continue;
    await frame.locator("body").click({ timeout: 5000 });
    await frame.locator("body").pressSequentially(body, { delay: 1 });
    return;
  }
  throw new Error("Composer body frame was not found");
}

function classifyFailure(result) {
  if (result?.captcha || result?.twoFactor || result?.manualRequired) return "auth_challenge";
  if (result?.cooldown) return "cooldown";
  return "project_or_proton_drift";
}
