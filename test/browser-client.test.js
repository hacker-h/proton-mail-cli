import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProtonMailBrowserClient, extractFirstOtpCode, matchOpenAiEmail, defaultSessionFile } from "../src/index.js";
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

  it("writes cooldown files with private permissions at creation time", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-cooldown-"));
    const sessionFile = path.join(tmpDir, "session.json");
    const originalWriteFileSync = fs.writeFileSync;
    const calls = [];

    fs.writeFileSync = (...args) => {
      calls.push(args);
      return originalWriteFileSync(...args);
    };

    try {
      __internal.writeCooldown(sessionFile, "Login failed");
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const writeCall = calls.find(([filePath]) => filePath.endsWith("protonmail-login-cooldown.json"));
    assert.ok(writeCall);
    assert.deepEqual(writeCall[2], { encoding: "utf8", mode: 0o600 });
  });

  it("writes saved browser sessions with private permissions at creation time", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protonmail-session-"));
    const sessionFile = path.join(tmpDir, "session.json");
    const storageState = { cookies: [], origins: [] };
    const storageStateCalls = [];
    const context = {
      async storageState(...args) {
        storageStateCalls.push(args);
        return storageState;
      },
    };
    const originalWriteFileSync = fs.writeFileSync;
    const calls = [];

    fs.writeFileSync = (...args) => {
      calls.push(args);
      return originalWriteFileSync(...args);
    };

    try {
      await __internal.saveSession(context, sessionFile);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.deepEqual(storageStateCalls, [[]]);
    const writeCall = calls.find(([filePath]) => filePath === sessionFile);
    assert.ok(writeCall);
    assert.deepEqual(JSON.parse(writeCall[1]), storageState);
    assert.deepEqual(writeCall[2], { encoding: "utf8", mode: 0o600 });
  });
});
