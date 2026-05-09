import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProtonMailBrowserClient,
  OTP_PROVIDER_PRESETS,
  extractFirstLink,
  extractFirstOtpCode,
  extractOtpCode,
  matchOpenAiEmail,
  defaultSessionFile,
} from "../src/index.js";
import { __internal } from "../src/browser-client.js";

describe("ProtonMailBrowserClient exports", () => {
  it("exports a constructible browser client", () => {
    const client = new ProtonMailBrowserClient({ headless: true });
    assert.ok(client);
    assert.equal(typeof client.loginAndSaveSession, "function");
    assert.equal(typeof client.getInboxMessages, "function");
    assert.equal(typeof client.getLatestMessage, "function");
    assert.equal(typeof client.extractOtpCode, "function");
  });

  it("extracts a 6-digit OTP from text", () => {
    assert.equal(extractFirstOtpCode("Your OpenAI code is 123456."), "123456");
    assert.equal(extractFirstOtpCode("No code here"), "");
  });

  it("extracts OTPs with custom RegExp and string patterns", () => {
    assert.equal(extractFirstOtpCode("Stripe login code: 42-4242", { pattern: /code:\s*(?<code>\d{2}-\d{4})/u }), "42-4242");
    assert.equal(extractFirstOtpCode("Auth0 token is ZX-987", { otpPattern: "token is (?<code>[A-Z]{2}-\\d{3})" }), "ZX-987");
  });

  it("uses named capture groups before positional captures or full matches", () => {
    assert.equal(extractFirstOtpCode("Use primary 111111 fallback 222222", { pattern: /primary (?<code>\d{6}) fallback (\d{6})/u }), "111111");
    assert.equal(extractFirstOtpCode("Ticket ID ABC-123", { pattern: /Ticket ID ([A-Z]{3}-\d{3})/u }), "ABC-123");
    assert.equal(extractFirstOtpCode("One-time token: ready", { pattern: /ready/u }), "ready");
  });

  it("returns an empty string for no match or malformed message text", () => {
    assert.equal(extractOtpCode("No code here", { pattern: /code:\s*(?<code>\d+)/u }), "");
    assert.equal(extractFirstOtpCode(null), "");
    assert.equal(extractFirstOtpCode(undefined), "");
  });

  it("supports built-in provider presets", () => {
    assert.ok(OTP_PROVIDER_PRESETS.generic);
    assert.ok(OTP_PROVIDER_PRESETS.github);
    assert.ok(OTP_PROVIDER_PRESETS.magicLink);
    assert.equal(extractFirstOtpCode("Your code is 654321", { provider: "generic" }), "654321");
    assert.equal(extractFirstOtpCode("Your code is 123456", { provider: "generic-6-digit" }), "123456");
    assert.equal(extractFirstOtpCode("Enter GitHub device code WDJB-MJHT to continue", { provider: "github" }), "WDJB-MJHT");
    assert.equal(extractFirstOtpCode("GitHub device code WDJB-MJHT", { provider: "github-device-auth" }), "WDJB-MJHT");
  });

  it("extracts magic links with provider and custom link patterns", () => {
    assert.equal(extractFirstLink("Sign in: https://example.test/magic?token=abc", { provider: "magic-link-url" }), "https://example.test/magic?token=abc");
    assert.equal(extractFirstLink("Go https://example.test/path/ now", { provider: "magic-link-url" }), "https://example.test/path/");
    assert.equal(extractFirstLink("Use https://example.test/magic?token=abc= to continue", { provider: "magic-link-url" }), "https://example.test/magic?token=abc=");
    assert.equal(extractFirstLink("Open https://example.test/magic?token=abc.", { provider: "magic-link-url" }), "https://example.test/magic?token=abc");
    assert.equal(extractFirstLink("Click <https://accounts.example.test/start>", { linkPattern: /<(?<link>https:\/\/accounts\.example\.test\/[^>]+)>/u }), "https://accounts.example.test/start");
  });

  it("extracts OTPs with global regex patterns without leaking lastIndex", () => {
    const globalPattern = /code (?<code>\d{6})/gu;
    assert.equal(extractFirstOtpCode("first code 123456", { pattern: globalPattern }), "123456");
    assert.equal(extractFirstOtpCode("second code 987654", { pattern: globalPattern }), "987654");
  });

  it("supports /source/flags style pattern strings", () => {
    assert.equal(extractFirstOtpCode("CODE: 2468", { otpPattern: "/code:\\s*(?<code>\\d{4})/i" }), "2468");
  });

  it("throws on malformed extraction patterns", () => {
    assert.throws(() => extractFirstOtpCode("Your code is 123456", { otpPattern: "" }), /pattern|RegExp|non-empty/i);
    assert.throws(() => extractFirstLink("Go to https://example.test", { linkPattern: "" }), /pattern|RegExp|non-empty/i);
  });

  it("applies provider presets in the browser OTP flow without launching Playwright", async () => {
    const client = new ProtonMailBrowserClient({ headless: true });
    let requestedMatchText;
    client.getLatestMessage = async (options) => {
      requestedMatchText = options.matchText;
      return {
        success: true,
        message: {
          subject: "GitHub device verification",
          bodyText: "Enter WDJB-MJHT on GitHub to continue.",
        },
      };
    };

    const result = await client.extractOtpCode({ provider: "github" });

    assert.equal(result.success, true);
    assert.equal(result.code, "WDJB-MJHT");
    assert.equal(requestedMatchText.test("noreply@github.com"), true);
  });

  it("returns a magic link from the browser OTP flow when configured", async () => {
    const client = new ProtonMailBrowserClient({ headless: true });
    client.getLatestMessage = async () => ({
      success: true,
      message: {
        subject: "Passwordless sign-in",
        bodyText: "Use https://login.example.test/magic?token=abc to sign in.",
      },
    });

    const result = await client.extractOtpCode({ provider: "magic-link-url" });

    assert.equal(result.success, true);
    assert.equal(result.code, "");
    assert.equal(result.link, "https://login.example.test/magic?token=abc");
  });

  it("matches OpenAI-related previews", () => {
    assert.equal(matchOpenAiEmail("OpenAI verification code"), true);
    assert.equal(matchOpenAiEmail("noreply@openai.com sent a sign in code"), true);
    assert.equal(matchOpenAiEmail("Invoice from another sender"), false);
  });

  it("provides a default session file path", () => {
    assert.ok(defaultSessionFile().endsWith("data/protonmail-auth.json"));
  });

  it("does not classify generic challenge wording as CAPTCHA", () => {
    assert.equal(__internal.hasAuthChallengeText("Challenge yourself with encrypted email"), false);
    assert.equal(__internal.hasAuthChallengeText("A secure login protects your account"), false);
  });

  it("classifies visible human-verification wording as an auth challenge", () => {
    assert.equal(__internal.hasAuthChallengeText("Please verify that you are human"), true);
    assert.equal(__internal.hasAuthChallengeText("Complete this security check"), true);
  });

  it("emits debug logs only when Proton debug mode is enabled", () => {
    const previousDebug = process.env.PROTONMAIL_DEBUG;
    const warning = mock.method(console, "warn", () => {});

    try {
      assert.equal(__internal.isDebugLoggingEnabled({ PROTONMAIL_DEBUG: "true" }), true);
      delete process.env.PROTONMAIL_DEBUG;
      __internal.debugLog("hidden failure", new Error("hidden"));
      assert.equal(warning.mock.callCount(), 0);

      process.env.PROTONMAIL_DEBUG = "1";
      __internal.debugLog("visible failure", new Error("boom"));
      assert.equal(warning.mock.callCount(), 1);
      assert.match(warning.mock.calls[0].arguments[0], /\[protonmail-debug\] visible failure: boom/u);

      __internal.debugLog("injected env failure", new Error("boom"), { PROTONMAIL_DEBUG: "true" });
      assert.equal(warning.mock.callCount(), 2);
    } finally {
      warning.mock.restore();
      if (previousDebug === undefined) {
        delete process.env.PROTONMAIL_DEBUG;
      } else {
        process.env.PROTONMAIL_DEBUG = previousDebug;
      }
    }
  });

  it("writes cooldown files with private file mode at creation time", () => {
    const sessionFile = path.join(os.tmpdir(), "protonmail-browser-client-test", "session.json");
    const cooldownFile = path.join(path.dirname(sessionFile), "protonmail-login-cooldown.json");
    const originalMkdirSync = fs.mkdirSync;
    const originalWriteFileSync = fs.writeFileSync;
    const originalRenameSync = fs.renameSync;
    const originalChmodSync = fs.chmodSync;
    const mkdirs = [];
    const writes = [];
    const renames = [];
    const chmods = [];

    fs.mkdirSync = (dirPath, options) => {
      mkdirs.push({ dirPath, options });
    };
    fs.writeFileSync = (filePath, content, options) => {
      writes.push({ filePath, content, options });
    };
    fs.renameSync = (oldPath, newPath) => {
      renames.push({ oldPath, newPath });
    };
    fs.chmodSync = (filePath, mode) => {
      chmods.push({ filePath, mode });
    };

    try {
      __internal.writeCooldown(sessionFile, "CAPTCHA detected");
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
      fs.chmodSync = originalChmodSync;
    }

    assert.deepEqual(mkdirs[0], { dirPath: path.dirname(sessionFile), options: { recursive: true } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath.startsWith(`${cooldownFile}.`), true);
    assert.deepEqual(writes[0].options, { encoding: "utf8", mode: 0o600 });
    assert.equal(JSON.parse(writes[0].content).reason, "CAPTCHA detected");
    assert.deepEqual(renames, [{ oldPath: writes[0].filePath, newPath: cooldownFile }]);
    assert.equal(chmods.some((call) => call.filePath === cooldownFile), false);
  });

  it("writes browser storage state with private file mode at creation time", async () => {
    const sessionFile = path.join(os.tmpdir(), "protonmail-browser-client-test", "session.json");
    const storageState = { cookies: [], origins: [] };
    const originalMkdirSync = fs.mkdirSync;
    const originalWriteFileSync = fs.writeFileSync;
    const originalRenameSync = fs.renameSync;
    const originalChmodSync = fs.chmodSync;
    const mkdirs = [];
    const writes = [];
    const renames = [];
    const chmods = [];
    let storageStateOptions;

    fs.mkdirSync = (dirPath, options) => {
      mkdirs.push({ dirPath, options });
    };
    fs.writeFileSync = (filePath, content, options) => {
      writes.push({ filePath, content, options });
    };
    fs.renameSync = (oldPath, newPath) => {
      renames.push({ oldPath, newPath });
    };
    fs.chmodSync = (filePath, mode) => {
      chmods.push({ filePath, mode });
    };

    try {
      await __internal.saveSession({
        storageState: async (options) => {
          storageStateOptions = options;
          return storageState;
        },
      }, sessionFile);
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
      fs.chmodSync = originalChmodSync;
    }

    assert.equal(storageStateOptions, undefined);
    assert.deepEqual(mkdirs[0], { dirPath: path.dirname(sessionFile), options: { recursive: true } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath.startsWith(`${sessionFile}.`), true);
    assert.deepEqual(writes[0].options, { encoding: "utf8", mode: 0o600 });
    assert.deepEqual(JSON.parse(writes[0].content), storageState);
    assert.deepEqual(renames, [{ oldPath: writes[0].filePath, newPath: sessionFile }]);
    assert.equal(chmods.some((call) => call.filePath === sessionFile), false);
  });

  it("replaces existing session and cooldown files with private-mode files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-browser-client-test-"));
    const sessionFile = path.join(tempDir, "session.json");
    const cooldownFile = path.join(tempDir, "protonmail-login-cooldown.json");

    try {
      fs.writeFileSync(sessionFile, "{}\n", { encoding: "utf8", mode: 0o644 });
      fs.writeFileSync(cooldownFile, "{}\n", { encoding: "utf8", mode: 0o644 });

      await __internal.saveSession({ storageState: async () => ({ cookies: [], origins: [] }) }, sessionFile);
      __internal.writeCooldown(sessionFile, "CAPTCHA detected");

      assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(cooldownFile).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
