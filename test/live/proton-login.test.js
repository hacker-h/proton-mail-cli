import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProtonMailBrowserClient } from "../../src/index.js";

const liveEnabled = process.env.PROTONMAIL_LIVE_TEST === "1";
const hasSeededSession = Boolean(process.env.PROTONMAIL_SESSION_JSON);
const hasConfiguredSessionFile = Boolean(process.env.PROTONMAIL_LIVE_SESSION_FILE && fs.existsSync(process.env.PROTONMAIL_LIVE_SESSION_FILE));
const hasCredentials = Boolean(process.env.PROTONMAIL_USERNAME && process.env.PROTONMAIL_PASSWORD);
const freshLoginAllowed = process.env.PROTONMAIL_ALLOW_FRESH_LOGIN === "1";
const shouldRun = liveEnabled && (hasSeededSession || hasConfiguredSessionFile || (hasCredentials && freshLoginAllowed));
const testOptions = shouldRun ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 with PROTONMAIL_SESSION_JSON, or explicitly allow fresh login with credentials" };
const pureLoginOptions = liveEnabled && hasCredentials && freshLoginAllowed ? {} : { skip: "Set PROTONMAIL_LIVE_TEST=1 and PROTONMAIL_ALLOW_FRESH_LOGIN=1 with credentials" };

let tmpDir = "";

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("live Proton login", testOptions, () => {
  it("logs in automatically and reuses the saved browser session", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-live-"));
    const configuredSessionFile = process.env.PROTONMAIL_LIVE_SESSION_FILE || "";
    const sessionFile = configuredSessionFile || path.join(tmpDir, "session.json");
    if (configuredSessionFile) {
      fs.mkdirSync(path.dirname(configuredSessionFile), { recursive: true });
      tmpDir = "";
    }
    const headless = process.env.PROTONMAIL_LIVE_HEADLESS !== "0";
    const seededSession = process.env.PROTONMAIL_SESSION_JSON || "";

    if (seededSession) {
      fs.writeFileSync(sessionFile, seededSession, { encoding: "utf8", mode: 0o600 });
    }

    const client = new ProtonMailBrowserClient({
      headless,
      sessionFile,
      timeoutSeconds: 120,
      manualLoginTimeoutSeconds: 120,
    });

    const login = await client.loginAndSaveSession({
      headless,
      manualFallback: false,
      timeoutSeconds: 120,
    });

    assert.equal(login.success, true, formatLiveFailure(login));
    assert.equal(login.sessionValid, true);
    assert.equal(fs.existsSync(sessionFile), true);
    if ((seededSession || configuredSessionFile) && !freshLoginAllowed) {
      assert.equal(login.loginMethod, "session", "Seeded CI sessions must be reused without credential login");
    }

    const savedSession = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    assert.ok(Array.isArray(savedSession.cookies));
    assert.ok(savedSession.cookies.length > 0);

    const reuse = await client.loginAndSaveSession({
      headless,
      manualFallback: false,
      timeoutSeconds: 120,
    });

    assert.equal(reuse.success, true, formatLiveFailure(reuse));
    assert.equal(reuse.sessionValid, true);
    assert.equal(reuse.loginMethod, "session");
  });

  it("logs in from scratch with username and password", pureLoginOptions, async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-live-pure-login-"));
    const sessionFile = path.join(tmpDir, "session.json");
    const headless = process.env.PROTONMAIL_LIVE_HEADLESS !== "0";

    const client = new ProtonMailBrowserClient({
      headless,
      sessionFile,
      timeoutSeconds: 120,
      manualLoginTimeoutSeconds: 120,
    });

    const login = await client.loginAndSaveSession({
      headless,
      manualFallback: false,
      timeoutSeconds: 120,
    });

    assert.equal(login.success, true, formatLiveFailure(login));
    assert.equal(login.sessionValid, true);
    assert.notEqual(login.loginMethod, "session", "Pure login must not pass only by reusing a saved session");
    assert.equal(fs.existsSync(sessionFile), true);

    const savedSession = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    assert.ok(Array.isArray(savedSession.cookies));
    assert.ok(savedSession.cookies.length > 0);
  });
});

function formatLiveFailure(result) {
  return JSON.stringify({
    category: classifyFailure(result),
    error: result?.error || "Proton login failed",
    captcha: Boolean(result?.captcha),
    twoFactor: Boolean(result?.twoFactor),
    cooldown: Boolean(result?.cooldown),
    manualRequired: Boolean(result?.manualRequired),
    sessionValid: Boolean(result?.sessionValid),
  });
}

function classifyFailure(result) {
  if (result?.captcha || result?.twoFactor || result?.manualRequired) {
    return "auth_challenge";
  }
  if (result?.cooldown) {
    return "cooldown";
  }
  return "project_or_proton_drift";
}
